import { atom, read, update } from "claude-code"
import type { EngineInterface, Register } from "claude-code"

import type { Picker, Setting } from "../types"

import { Channel } from "./channel"
import { type Notices, type ReadMode, type TtsConfig, toConfig } from "./config"
import { DIALOG_TOOLS, dialogSpeech } from "./dialog-text"
import { type EngineName, ENGINES, type LoadedEngine } from "./engines"
import { type Pin, PINS_KEY, type Pins, pinnedOptions, toPins } from "./pins"
import { FIND_PLAYER, playCommand, trimCommand } from "./player"
import { SpeechProcess } from "./process"
import { type Change, MODE_LABELS, MODES, optionLine, planChange, SPEEDS, VOLUMES } from "./settings"
import { SpeechSplitter, toSentences } from "./speech-text"

const HELP = [
  "/tts                   state: on/off, mode, engine, speed, volume",
  "/tts on | off          read replies aloud or not",
  "/tts stop              stop speech and mute the rest of this turn",
  "/tts test [text]       read a test sentence",
  "/tts mode [name]       stream | final | notify; no name opens a picker",
  "/tts engine [name]     switch engines; no name checks whether each one answers",
  "/tts voice [id]        pick a voice; no id opens a picker",
  "/tts speed [n]         speech speed (1: as is, Irodori: 0.25–4); no value opens a picker",
  "/tts volume [n]        playback volume (1: as is); no value opens a picker",
  "/tts pin | unpin       keep this directory's engine and voice apart from the rest, or stop",
  "/tts config            every setting and its value; change them in /config → tts",
  "/tts help              this list",
].join("\n")
/** Which notice notify mode says as a turn ends; an interrupted turn stays silent. */
const TURN_NOTICES: Partial<Record<string, keyof Notices>> = { answer: "done", error: "error", refusal: "refusal" }
const PICKER_PANE = "tts-picker"
const picker = atom({ plugin: "tts", key: "picker" } as const, null as Picker | null)
// Survives a reload so the next module can remove the old module's audio files.
const audioDirectory = atom({ plugin: "tts", key: "audioDirectory" } as const, null as string | null)

/** Irodori runs diffusion with a concurrency of 1, so one request can take minutes. */
const SYNTH_TIMEOUT_MS = 300_000

/** How much of one model response has been queued; past the limit the rest is dropped. */
type Budget = { spoken: number; isCut: boolean }

/** `cacheAs` keeps the synthesized clip at that path for the next time. */
type Sentence = { text: string; generation: number; cacheAs?: string }
type Clip = { file: string; generation: number; isCached?: boolean }

export const register: Register = (on, options) => {
  let config = toConfig(options)
  let engine = ENGINES[config.engine].load(options)
  let fallback = config.fallback === undefined ? undefined : ENGINES[config.fallback].load(options)
  // The working directory's pin, if any, lays its engine and voice over the options.
  let cwd = ""
  let pins: Pins = {}

  // `generation` moves on at every stop: queued work of an older one is dropped.
  let generation = 0
  let isTurnMuted = false
  const { isEnabled } = config
  let player: string | undefined
  const synthesisProcess = new SpeechProcess()
  const playbackProcess = new SpeechProcess()
  const sentences = new Channel<Sentence>()
  const clips = new Channel<Clip>()
  // Notices are few and fixed: each is synthesized once per load, then replayed at once.
  const cachedNotices = new Map<string, string>()
  let directory = ""
  let noticeCount = 0
  // Set while the engine in use fails ("voicevox down"); shown beside playback until it reads again.
  let engineIssue: string | undefined
  // Set by session.start: probes the engine in use and shows the result.
  let recheckEngine = () => {}

  /** Rebuilds the engines from the options with this directory's pin laid over them. */
  const applyPins = (stored: Pins) => {
    pins = stored
    const effective = pinnedOptions(options, pins[cwd])
    config = toConfig(effective)
    engine = ENGINES[config.engine].load(effective)
    fallback = config.fallback === undefined ? undefined : ENGINES[config.fallback].load(effective)
    // Cached notices were spoken in the voice before.
    cachedNotices.clear()
    recheckEngine()
  }

  /** What saving `value` for `setting` changes, against the settings in effect here. */
  const changeOf = (setting: Setting, value: string) => planChange(setting, value, { options, config, engine, cwd, pin: pins[cwd] })

  /** Invalidates queued speech and closes the active synthesis and playback streams. */
  const stop = async () => {
    generation += 1
    await Promise.all([synthesisProcess.stop(), playbackProcess.stop()])
  }

  /** Queues `text` to be said next; called right after a stop, it plays first. */
  const queueNotice = (text: string) => {
    if (text === "") return
    const cached = cachedNotices.get(text)
    if (cached !== undefined) return clips.push({ file: cached, generation, isCached: true })
    sentences.push({ text, generation, cacheAs: `${directory}/notice-${noticeCount++}.wav` })
  }

  /** Queues sentences; with a budget, stops at the limit and says once that the rest is skipped. */
  const enqueue = (texts: readonly string[], budget?: Budget) => {
    for (const text of texts) {
      if (budget !== undefined && config.maxCharsPerTurn > 0) {
        if (budget.isCut) return
        const remaining = Math.max(0, Math.floor(config.maxCharsPerTurn - budget.spoken))
        const characters = Array.from(text)
        if (characters.length > remaining) {
          if (remaining > 0) sentences.push({ text: characters.slice(0, remaining).join(""), generation })
          budget.isCut = true
          if (config.notices.cut !== "") sentences.push({ text: config.notices.cut, generation })
          return
        }
        budget.spoken += characters.length
      }
      sentences.push({ text, generation })
    }
  }

  on("session.start", async ($, e, next) => {
    const started = await next(e)
    cwd = await $.session.cwd()
    applyPins(toPins(await $.store.get(PINS_KEY)))
    player = config.player === "auto" ? (await $.process.run(FIND_PLAYER)).stdout.trim() || undefined : config.player
    if (player === undefined) $.ui.toast("tts: no audio player found (ffplay, paplay, aplay, afplay, powershell.exe)")

    directory = await prepareDirectory($)
    let clipCount = 0
    let lastErrorAt = 0

    const noteEngine = (error?: unknown) => {
      const issue = error === undefined ? undefined : `${config.engine} ${/is not set/.test(String(error)) ? "unset" : "down"}`
      showEngineIssue(issue)
    }
    // The status line shows only a failing engine; Claude Code draws it as "⚠ tts: voicevox down".
    const showEngineIssue = (issue: string | undefined) => {
      if (issue === engineIssue) return
      engineIssue = issue
      $.ui.status(issue)
    }
    // The last module's line stays after a reload.
    $.ui.status(undefined)

    // The fallback reads on quietly: the status line says the engine is failing.
    const reportFallback = (error: unknown) => {
      $.ui.log(`tts: ${config.engine} failed, read with ${config.fallback}: ${String(error)}`, { to: "debug" })
    }

    const reportError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      $.ui.log(`tts: ${message}`, { to: "debug" })
      // One toast per burst: a server that is down fails every sentence of a reply.
      if (Date.now() - lastErrorAt > 30_000) $.ui.toast(`tts: ${message}`)
      lastErrorAt = Date.now()
    }

    // Synthesis runs ahead of playback, one request at a time.
    void (async () => {
      for (;;) {
        const sentence = await sentences.take()
        if (sentence.generation !== generation) continue
        const file = sentence.cacheAs ?? `${directory}/${String(clipCount++).padStart(6, "0")}.wav`
        const isCurrent = () => sentence.generation === generation
        let isFallback = false
        try {
          try {
            await synthesize($, synthesisProcess, engine, sentence.text, file, isCurrent)
            if (isCurrent()) noteEngine()
          } catch (error) {
            if (isCurrent()) noteEngine(error)
            if (!isCurrent() || fallback === undefined || config.fallback === undefined) throw error
            isFallback = true
            await synthesize($, synthesisProcess, fallback, sentence.text, file, isCurrent)
            reportFallback(error)
          }
          if (!isCurrent()) {
            await $.process.run(["rm", "-f", file])
            continue
          }
          // Done while the clip before plays; an untrimmed clip still plays.
          await runProcess($, synthesisProcess, trimCommand(file), undefined, 30_000).catch(() => undefined)
          if (!isCurrent()) {
            await $.process.run(["rm", "-f", file, `${file}.t.wav`])
            continue
          }
          // A notice the fallback read is kept for this time only: the engine may be back next time.
          const isCached = sentence.cacheAs !== undefined && !isFallback
          if (isCached) cachedNotices.set(sentence.text, file)
          clips.push({ file, generation: sentence.generation, isCached })
        } catch (error) {
          await $.process.run(["rm", "-f", file])
          if (isCurrent()) reportError(error)
        }
      }
    })()

    void (async () => {
      for (;;) {
        const clip = await clips.take()
        if (clip.generation === generation && player !== undefined) {
          try {
            await playbackProcess.read($.process.spawn({ argv: playCommand(player, clip.file, config.volume) }))
          } catch (error) {
            if (clip.generation === generation) reportError(error)
          }
        }
        const files = [`${clip.file}.v.wav`]
        if (clip.isCached !== true) files.push(clip.file)
        await $.process.run(["rm", "-f", ...files])
      }
    })()

    // Checked at once, so a start or an engine switch shows a dead engine before anything is read.
    recheckEngine = () => {
      showEngineIssue(undefined)
      if (!isEnabled) return
      const checked = engine
      void checkEngine($, checked).then(state => {
        if (checked === engine && state !== "ok") showEngineIssue(`${config.engine} ${state}`)
      })
    }
    recheckEngine()

    await $.command.register({
      name: "tts",
      description: "Read replies aloud: on, off, stop, test, mode, engine, voice, speed, volume, pin, unpin, config, help",
      argumentHint: "[on|off|stop|test [text]|mode|engine|voice|speed|volume [value]|pin|unpin|config|help]",
      // `/tts stop` has to land while a reply is still being read.
      immediate: true,
    })
    return started
  })

  on("session.end", async ($, e, next) => {
    await stop()
    cachedNotices.clear()
    if (directory !== "") await $.process.run(["rm", "-rf", "--", directory])
    directory = ""
    await update($, audioDirectory, () => null)
    return next(e)
  }).catch(($, e, next) => next(e))

  // /clear, resume and /branch keep this module alive without another session.start, and reset
  // $.state, which holds the directory for the next reload to remove.
  on("classic.SessionStart", { source: ["clear", "resume", "fork"] }, async ($, e, next) => {
    if (directory === "") directory = await prepareDirectory($)
    else await update($, audioDirectory, () => directory)
    return next(e)
  }).catch(($, e, next) => next(e))

  on("command.run", { command: "tts" }, async ($, e) => {
    const [action = "", ...rest] = e.args.trim().split(/\s+/)
    switch (action) {
      case "on":
      case "off": {
        if (action === "off") await stop()
        const set = await $.config.set({ key: "tts.enabled", value: action === "on" })
        return { text: "deny" in set && set.deny ? set.deny : action }
      }
      case "stop": {
        isTurnMuted = true
        await stop()
        return { text: "stopped" }
      }
      case "test": {
        const text = rest.join(" ") || "読み上げのテストです。"
        try {
          engine.synthesis(text, "/dev/null")
        } catch (error) {
          if (fallback === undefined) return { text: error instanceof Error ? error.message : String(error) }
        }
        enqueue([text])
        return { text: `testing ${config.engine} (the first Irodori request loads the model and can take a while)` }
      }
      case "voice": {
        const { voices } = engine
        if (voices === undefined) return { text: `engine=${config.engine} has no voices; set it up in /config` }
        const voice = rest.join(" ")
        if (voice === "") {
          const listed = await $.http.fetch(voices.url)
          if (!listed.ok) return { text: `GET ${voices.url} failed with ${listed.status}` }
          const options = voices.parse(listed.text)
          const title = `${config.engine} voice`
          if (await openPicker($, { setting: "voice", title, options, value: voices.current })) {
            return { text: "pick a voice in the pane (Esc closes it)" }
          }
          return { text: [`${config.engine} voices (/tts voice <id>):`, ...options.map(optionLine)].join("\n") }
        }
        return { text: await commit($, changeOf("voice", voice), applyPins) }
      }
      case "mode": {
        const name = rest[0] as ReadMode | undefined
        if (name === undefined) {
          const options = MODES.map(mode => ({ value: mode, label: MODE_LABELS[mode] }))
          if (await openPicker($, { setting: "mode", title: "read mode", options, value: config.mode })) {
            return { text: "pick a mode in the pane (Esc closes it)" }
          }
          return { text: `mode: ${config.mode} (${MODES.join(" | ")})` }
        }
        return { text: await commit($, changeOf("mode", name), applyPins) }
      }
      case "speed":
      case "volume": {
        const value = rest[0]
        if (value === undefined) {
          const current = String(action === "speed" ? options.speed : config.volume)
          const choices = (action === "speed" ? SPEEDS : VOLUMES).map(each => ({ value: each, label: `× ${each}` }))
          if (await openPicker($, { setting: action, title: action, options: choices, value: current })) {
            return { text: `pick a ${action} in the pane (Esc closes it)` }
          }
          return { text: `${action}: ${current}` }
        }
        return { text: await commit($, changeOf(action, value), applyPins) }
      }
      case "pin": {
        const pin: Pin = { engine: config.engine, voices: engine.voices ? { [config.engine]: engine.voices.current } : {} }
        const stored = { ...toPins(await $.store.get(PINS_KEY)), [cwd]: pin }
        await $.store.set(PINS_KEY, stored)
        applyPins(stored)
        return {
          text: `pinned ${cwd}: ${config.engine} (${engine.voice})\nengine and voice changes here stay in this directory; /tts unpin undoes it`,
        }
      }
      case "unpin": {
        if (pins[cwd] === undefined) return { text: "this directory is not pinned" }
        const before = `${config.engine} (${engine.voice})`
        const { [cwd]: _unpinned, ...stored } = toPins(await $.store.get(PINS_KEY))
        await $.store.set(PINS_KEY, stored)
        applyPins(stored)
        return { text: `unpinned ${cwd}: ${before} → ${config.engine} (${engine.voice})` }
      }
      case "engine": {
        const name = rest[0]
        if (name === undefined) {
          const names = Object.keys(ENGINES) as EngineName[]
          const rows = await Promise.all(names.map(each => engineRow($, each, ENGINES[each].load(options), config)))
          return { text: ["engines (● answers, ○ down or unset; /tts engine <name> switches):", ...rows].join("\n") }
        }
        return { text: await commit($, changeOf("engine", name), applyPins) }
      }
      case "help":
        return { text: HELP }
      case "config": {
        const width = Math.max(...Object.keys(options).map(key => key.length))
        const rows = Object.entries(options).map(([key, value]) => `  ${key.padEnd(width)}  ${JSON.stringify(value)}`)
        const pinned = pins[cwd] === undefined ? [] : [`engine and voice are pinned here: ${config.engine} (${engine.voice})`]
        return { text: ["settings (change them in /config → tts):", ...rows, ...pinned].join("\n") }
      }
      case "": {
        const marks = await Promise.all([answerMark($, engine), fallback && answerMark($, fallback)])
        return {
          text: [
            `${isEnabled ? "on" : "off"} (mode: ${config.mode})`,
            `engine: ${marks[0]} ${config.engine} (${engine.voice})${config.fallback ? `, fallback: ${marks[1]} ${config.fallback}` : ""}`,
            `speed: ${options.speed}, volume: ${config.volume}`,
            ...(pins[cwd] === undefined ? [] : [`engine and voice pinned to ${cwd} (/tts unpin)`]),
            `player: ${player ?? "none"}`,
            "/tts help lists the commands",
          ].join("\n"),
        }
      }
      default:
        return { text: `unknown: ${action}\n\n${HELP}` }
    }
  })

  // The picker a `/tts` command without a value opens: a pick saves the setting and closes the pane.
  on("ui.render", { component: "Pane", requestId: PICKER_PANE }, async ($, e) => {
    const shown = await read($, picker)
    if (e.surface === "mobile" || shown === null || shown.options.length === 0) {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>{shown === null || shown.options.length === 0 ? "Nothing to pick." : shown.options.map(optionLine).join("\n")}</Text>
    }
    const { Box, Text, Select } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>{`${shown.title}: ↑↓ move, Enter picks, Esc closes`}</Text>
        <Select
          key={shown.setting}
          options={shown.options.map(option => ({ value: option.value, label: option.label ?? option.value }))}
          value={shown.value}
          autoFocus
          onSelect={async value => {
            await $.ui.close({ id: PICKER_PANE })
            $.ui.toast(`tts: ${await commit($, changeOf(shown.setting, value), applyPins)}`)
          }}
        />
      </Box>
    )
  })

  on("prompt.submit", async ($, e, next) => {
    if (config.interruptOnPrompt) await stop()
    return next(e)
  }).catch(($, e, next) => next(e))

  on("turn.start", async ($, e, next) => {
    isTurnMuted = false
    return next(e)
  })

  on("turn.complete", async ($, e, next) => {
    if (e.reason === "aborted" && e.agentId === undefined) await stop()
    if (isEnabled && !isTurnMuted && e.agentId === undefined) {
      if (config.mode === "final" && e.reason === "answer") enqueue(toSentences(e.answer), { spoken: 0, isCut: false })
      const notice = TURN_NOTICES[e.reason]
      if (config.mode === "notify" && notice !== undefined && config.notices[notice] !== "") enqueue([config.notices[notice]])
    }
    return next(e)
  })

  // Whatever the mode, a dialog waiting for the person cuts off the reading and is announced.
  on("tool.call", async ($, e, next) => {
    if (isEnabled && DIALOG_TOOLS.has(e.tool)) {
      await stop()
      const { notice, detail } = dialogSpeech(e.tool, e, config.notices)
      queueNotice(notice)
      enqueue(detail)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Raised as a permission dialog is about to be shown, not for a call a rule or the mode settles.
  on("classic.PermissionRequest", async ($, e, next) => {
    if (isEnabled && !DIALOG_TOOLS.has(e.tool_name)) {
      await stop()
      const { notice, detail } = dialogSpeech(e.tool_name, e.tool_input, config.notices)
      queueNotice(notice)
      enqueue(detail)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Speaks the main loop's text as it streams; thinking, tool calls and subagents stay silent.
  on("turn.step", async function* ($, e, next) {
    const stream = next(e)
    if (!isEnabled || config.mode !== "stream" || e.agentId !== undefined) return yield* stream

    // Each response has its own budget: text before a tool call does not use up the answer's.
    const budget: Budget = { spoken: 0, isCut: false }
    const splitter = new SpeechSplitter()
    const responseGeneration = generation
    const queueResponse = (texts: string[]) => {
      if (!isTurnMuted && responseGeneration === generation) enqueue(texts, budget)
    }
    let block: number | undefined
    try {
      for await (const chunk of stream) {
        if (chunk.kind === "text") {
          if (block !== undefined && block !== chunk.index) queueResponse(splitter.flush())
          block = chunk.index
          queueResponse(splitter.push(chunk.text))
        }
        yield chunk
      }
    } finally {
      // Runs even when the engine stops pulling after the last chunk: the line without a newline is said too.
      queueResponse(splitter.flush())
    }
    return stream.result
  })
}

/** Creates an owner-only directory, removing the previous module's files after a reload. */
async function prepareDirectory($: EngineInterface): Promise<string> {
  const previous = await read($, audioDirectory)
  if (previous !== null) await $.process.run(["rm", "-rf", "--", previous])
  const created = await $.process.run(["mktemp", "-d", "/tmp/claude-tts-XXXXXXXXXX"])
  if (created.exitCode !== 0 || created.stdout.trim() === "") throw new Error("tts: could not create a private audio directory")
  const directory = created.stdout.trim()
  await update($, audioDirectory, () => directory)
  return directory
}


// Everything handed $ stays in this file: the validator follows $ into this file's functions only.

/** Runs an engine's commands for one sentence; throws on the first that fails. */
async function synthesize(
  $: EngineInterface,
  process: SpeechProcess,
  engine: LoadedEngine,
  text: string,
  file: string,
  isCurrent: () => boolean,
) {
  let stdout = ""
  for (const step of engine.synthesis(text, file)) {
    if (!isCurrent()) return
    const stdin = typeof step.stdin === "function" ? step.stdin(stdout) : step.stdin
    const ran = await runProcess($, process, step.argv, stdin, SYNTH_TIMEOUT_MS)
    if (ran.code !== 0) {
      throw new Error(`${step.argv[0]} exited ${ran.code}: ${(ran.stderr || ran.stdout).trim().slice(0, 200)}`)
    }
    stdout = ran.stdout
  }
}

/** A cancellable command with the same time limit synthesis had under process.run. */
async function runProcess($: EngineInterface, process: SpeechProcess, argv: string[], input: string | undefined, timeoutMs: number) {
  const running = process.read($.process.spawn({ argv, input }))
  let timedOut = false
  const timer = $.clock.after(timeoutMs, () => {
    timedOut = true
    void process.stop()
  })
  try {
    const result = await running
    if (timedOut) throw new Error(`${argv[0]} timed out`)
    return result
  } finally {
    timer.cancel()
  }
}

/** Whether the engine can read now: set up (its synthesis builds) and answering its probe. */
async function checkEngine($: EngineInterface, engine: LoadedEngine): Promise<"ok" | "down" | "unset"> {
  if (engine.probe === undefined) return "unset"
  try {
    engine.synthesis("", "/dev/null")
  } catch {
    return "unset"
  }
  const probed = await $.process.run(engine.probe, { timeoutMs: 5_000 }).catch(() => undefined)
  return probed?.exitCode === 0 ? "ok" : "down"
}

/** ● when the engine answers now, ○ when it is down or not set up. */
async function answerMark($: EngineInterface, engine: LoadedEngine): Promise<string> {
  return (await checkEngine($, engine)) === "ok" ? "●" : "○"
}

/** One line of `/tts engine`: whether the engine answers now, where, and its role. */
async function engineRow($: EngineInterface, name: EngineName, engine: LoadedEngine, config: TtsConfig): Promise<string> {
  const role = name === config.engine ? "  ← in use" : name === config.fallback ? "  ← fallback" : ""
  return `  ${await answerMark($, engine)} ${name.padEnd(9)} ${engine.location}${role}`
}

/** Opens the picker pane on `shown`; false when the surface cannot place it. */
async function openPicker($: EngineInterface, shown: Picker): Promise<boolean> {
  await update($, picker, () => shown)
  const rows = Math.min(shown.options.length + 3, 14)
  const opened = await $.ui.open({ id: PICKER_PANE, title: `tts ${shown.setting}`, focus: true, closeOnEscape: true, rows })
  return opened.isPlaced
}


/**
 * Saves a change, to `/config` (which reloads the module) or to this
 * directory's pin; answers how it reads, before and after, or why it did not.
 */
async function commit($: EngineInterface, change: Change, applyPins: (stored: Pins) => void): Promise<string> {
  if ("error" in change) return change.error
  if ("config" in change) {
    const set = await $.config.set(change.config)
    if ("deny" in set && set.deny) return set.deny
  } else {
    const stored = change.pins(toPins(await $.store.get(PINS_KEY)))
    await $.store.set(PINS_KEY, stored)
    applyPins(stored)
  }
  return `${change.label}: ${change.previous} → ${change.next}`
}
