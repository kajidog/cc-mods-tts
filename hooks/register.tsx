import { atom, read, update } from "claude-code"
import type { EngineInterface, Register } from "claude-code"

import type { Picker, PickerOption, Setting } from "../types"

import { type Notices, type ReadMode, type TtsConfig, toConfig } from "./config"
import { DIALOG_TOOLS, dialogSpeech } from "./dialog-text"
import { type EngineName, ENGINES, type LoadedEngine } from "./engines"
import { type Pin, PINS_KEY, type Pins, pinnedOptions, toPins } from "./pins"
import { FIND_PLAYER, playCommand, trimCommand } from "./player"
import { SpeechSplitter, toSentences } from "./speech-text"

const MODES: readonly ReadMode[] = ["stream", "final", "notify"]
const MODE_LABELS: Record<ReadMode, string> = {
  stream: "stream  返答を一文ずつ、流れてくるそばから",
  final: "final   ターンが終わってから最終的な返答だけ",
  notify: "notify  完了・エラーなどの短い通知だけ",
}
const SPEEDS = ["0.8", "1", "1.2", "1.5", "2"]
const VOLUMES = ["0.5", "0.75", "1", "1.25", "1.5"]
const HELP = [
  "/tts                   state: on/off, mode, engine, speed, volume",
  "/tts on | off          read replies aloud or not",
  "/tts stop              drop what is playing and queued",
  "/tts test [text]       read a test sentence",
  "/tts mode [name]       stream | final | notify; no name opens a picker",
  "/tts engine [name]     switch engines; no name checks whether each one answers",
  "/tts voice [id]        pick a voice; no id opens a picker",
  "/tts speed [n]         speech speed (1: as is); no value opens a picker",
  "/tts volume [n]        playback volume (1: as is); no value opens a picker",
  "/tts pin | unpin       keep this directory's engine and voice apart from the rest, or stop",
  "/tts config            every setting and its value; change them in /config → tts",
  "/tts help              this list",
].join("\n")
/** Which notice notify mode says as a turn ends; an interrupted turn stays silent. */
const TURN_NOTICES: Partial<Record<string, keyof Notices>> = { answer: "done", error: "error", refusal: "refusal" }
const PICKER_PANE = "tts-picker"
const picker = atom({ plugin: "tts", key: "picker" } as const, null as Picker | null)

/** Irodori runs diffusion with a concurrency of 1, so one request can take minutes. */
const SYNTH_TIMEOUT_MS = 300_000

/** An unbounded queue whose `take` waits for the next item. */
class Channel<T> {
  private items: T[] = []
  private waiter: (() => void) | undefined

  get size(): number {
    return this.items.length
  }

  push(item: T) {
    this.items.push(item)
    this.waiter?.()
    this.waiter = undefined
  }

  async take(): Promise<T> {
    while (this.items.length === 0) await new Promise<void>(resolve => (this.waiter = resolve))
    return this.items.shift() as T
  }
}

/** How much of one model response has been queued; past the limit the rest is dropped. */
type Budget = { spoken: number; isCut: boolean }

/** A setting change ready to save: where it goes, and how it reads before and after. */
type Change =
  | { label: string; previous: string; next: string; config: { key: string; value: string | number } }
  | { label: string; previous: string; next: string; pins: (stored: Pins) => Pins }
  | { error: string }

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
  const { isEnabled } = config
  let isSynthesizing = false
  let player: string | undefined
  let playingPid: string | undefined
  const sentences = new Channel<Sentence>()
  const clips = new Channel<Clip>()
  // Notices are few and fixed: each is synthesized once per load, then replayed at once.
  const cachedNotices = new Map<string, string>()
  let directory = "/tmp"
  let noticeCount = 0

  /** Rebuilds the engines from the options with this directory's pin laid over them. */
  const applyPins = (stored: Pins) => {
    pins = stored
    const effective = pinnedOptions(options, pins[cwd])
    config = toConfig(effective)
    engine = ENGINES[config.engine].load(effective)
    fallback = config.fallback === undefined ? undefined : ENGINES[config.fallback].load(effective)
    // Cached notices were spoken in the voice before.
    cachedNotices.clear()
  }

  /** What saving `value` for `setting` changes; while pinned, engine and voice go to the pin. */
  const planChange = (setting: Setting, value: string): Change => {
    const pin = pins[cwd]
    const pinned = (update: (base: Pin) => Pin) => (stored: Pins) => {
      const base = stored[cwd] ?? pin
      return base === undefined ? stored : { ...stored, [cwd]: update(base) }
    }
    switch (setting) {
      case "mode":
        if (!MODES.includes(value as ReadMode)) return { error: `mode is one of ${MODES.join(", ")}` }
        return { label: "mode", previous: config.mode, next: value, config: { key: "tts.mode", value } }
      case "speed":
      case "volume": {
        const scale = Number(value)
        if (!(scale > 0 && scale <= 4)) return { error: `${setting} is a number above 0, up to 4` }
        const previous = String(setting === "speed" ? options.speed : config.volume)
        return { label: setting, previous, next: String(scale), config: { key: `tts.${setting}`, value: scale } }
      }
      case "engine": {
        if (!(value in ENGINES)) return { error: `engine is one of ${Object.keys(ENGINES).join(", ")}` }
        const name = value as EngineName
        if (pin === undefined) return { label: "engine", previous: config.engine, next: name, config: { key: "tts.engine", value: name } }
        return { label: "engine (this directory)", previous: config.engine, next: name, pins: pinned(base => ({ ...base, engine: name })) }
      }
      case "voice": {
        const { voices } = engine
        if (voices === undefined) return { error: `engine=${config.engine} has no voices; set it up in /config` }
        if (pin === undefined) return { label: "voice", previous: voices.current, next: value, config: voices.select(value) }
        const name = config.engine
        return {
          label: "voice (this directory)",
          previous: voices.current,
          next: value,
          pins: pinned(base => ({ ...base, voices: { ...base.voices, [name]: value } })),
        }
      }
    }
  }

  /** Drops queued speech; answers the pid of the player to kill, if one plays. */
  const stop = (): string | undefined => {
    generation += 1
    return playingPid
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
        if (budget.spoken >= config.maxCharsPerTurn) {
          budget.isCut = true
          if (config.notices.cut !== "") sentences.push({ text: config.notices.cut, generation })
          return
        }
        budget.spoken += text.length
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

    directory = `/tmp/claude-tts-${await $.session.id()}`
    await $.process.run(["mkdir", "-p", directory])
    let clipCount = 0
    let lastErrorAt = 0

    // Either loop may finish the last item, a dropped one included.
    const clearStatusWhenIdle = () => {
      if (!isSynthesizing && sentences.size === 0 && clips.size === 0) $.ui.status(undefined)
    }
    // A reload kills the player mid-clip, leaving the last module's status behind.
    $.ui.status(undefined)

    // The fallback reads on quietly: one toast a burst says the engine is failing.
    let lastFallbackAt = 0
    const reportFallback = (error: unknown) => {
      $.ui.log(`tts: ${config.engine} failed, read with ${config.fallback}: ${String(error)}`, { to: "debug" })
      if (Date.now() - lastFallbackAt > 30_000) $.ui.toast(`tts: ${config.engine} failed; reading with ${config.fallback}`)
      lastFallbackAt = Date.now()
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
        if (sentence.generation !== generation) {
          clearStatusWhenIdle()
          continue
        }
        const file = sentence.cacheAs ?? `${directory}/${String(clipCount++).padStart(6, "0")}.wav`
        isSynthesizing = true
        try {
          try {
            await synthesize($, engine, sentence.text, file)
          } catch (error) {
            if (fallback === undefined) throw error
            await synthesize($, fallback, sentence.text, file)
            reportFallback(error)
          }
          // Done while the clip before plays; an untrimmed clip still plays.
          await $.process.run(trimCommand(file)).catch(() => undefined)
          if (sentence.cacheAs !== undefined) cachedNotices.set(sentence.text, file)
          clips.push({ file, generation: sentence.generation, isCached: sentence.cacheAs !== undefined })
        } catch (error) {
          await $.process.run(["rm", "-f", file])
          if (sentence.generation === generation) reportError(error)
        } finally {
          isSynthesizing = false
        }
        clearStatusWhenIdle()
      }
    })()

    void (async () => {
      for (;;) {
        const clip = await clips.take()
        if (clip.generation === generation && player !== undefined) {
          $.ui.status(`🔊 ${config.engine}`)
          try {
            for await (const piece of $.process.spawn({ argv: playCommand(player, clip.file, config.volume) })) {
              if (piece.stream === "stdout" && playingPid === undefined) playingPid = piece.text.split("\n")[0]?.trim()
            }
          } catch (error) {
            reportError(error)
          } finally {
            playingPid = undefined
          }
        }
        if (clip.isCached !== true) await $.process.run(["rm", "-f", clip.file])
        clearStatusWhenIdle()
      }
    })()

    await $.command.register({
      name: "tts",
      description: "Read replies aloud: on, off, stop, test, mode, engine, voice, speed, volume, pin, unpin, config, help",
      argumentHint: "[on|off|stop|test [text]|mode|engine|voice|speed|volume [value]|pin|unpin|config|help]",
    })
    return started
  })

  on("command.run", { command: "tts" }, async ($, e) => {
    const [action = "", ...rest] = e.args.trim().split(/\s+/)
    switch (action) {
      case "on":
      case "off": {
        if (action === "off") await killPlayer($, stop())
        const set = await $.config.set({ key: "tts.enabled", value: action === "on" })
        return { text: "deny" in set && set.deny ? set.deny : action }
      }
      case "stop": {
        await killPlayer($, stop())
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
        return { text: await commit($, planChange("voice", voice), applyPins) }
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
        return { text: await commit($, planChange("mode", name), applyPins) }
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
        return { text: await commit($, planChange(action, value), applyPins) }
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
        return { text: await commit($, planChange("engine", name), applyPins) }
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
            $.ui.toast(`tts: ${await commit($, planChange(shown.setting, value), applyPins)}`)
          }}
        />
      </Box>
    )
  })

  on("prompt.submit", async ($, e, next) => {
    if (config.interruptOnPrompt) await killPlayer($, stop())
    return next(e)
  }).catch(($, e, next) => next(e))

  on("turn.complete", async ($, e, next) => {
    if (e.reason === "aborted") await killPlayer($, stop())
    if (isEnabled && e.agentId === undefined) {
      if (config.mode === "final" && e.reason === "answer") enqueue(toSentences(e.answer), { spoken: 0, isCut: false })
      const notice = TURN_NOTICES[e.reason]
      if (config.mode === "notify" && notice !== undefined && config.notices[notice] !== "") enqueue([config.notices[notice]])
    }
    return next(e)
  })

  // Whatever the mode, a dialog waiting for the person cuts off the reading and is announced.
  on("tool.call", async ($, e, next) => {
    if (isEnabled && DIALOG_TOOLS.has(e.tool)) {
      await killPlayer($, stop())
      const { notice, detail } = dialogSpeech(e.tool, e, config.notices)
      queueNotice(notice)
      enqueue(detail)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Raised as a permission dialog is about to be shown, not for a call a rule or the mode settles.
  on("classic.PermissionRequest", async ($, e, next) => {
    if (isEnabled && !DIALOG_TOOLS.has(e.tool_name)) {
      await killPlayer($, stop())
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
    let block: number | undefined
    try {
      for await (const chunk of stream) {
        if (chunk.kind === "text") {
          if (block !== undefined && block !== chunk.index) enqueue(splitter.flush(), budget)
          block = chunk.index
          enqueue(splitter.push(chunk.text), budget)
        }
        yield chunk
      }
    } finally {
      // Runs even when the engine stops pulling after the last chunk: the line without a newline is said too.
      enqueue(splitter.flush(), budget)
    }
    return stream.result
  })
}

/** Ends the playback `stop` answered the pid of, if one was playing. */
async function killPlayer($: EngineInterface, pid: string | undefined) {
  if (pid !== undefined) await $.process.run(["kill", pid])
}

/** Runs an engine's commands for one sentence; throws on the first that fails. */
async function synthesize($: EngineInterface, engine: LoadedEngine, text: string, file: string) {
  let stdout = ""
  for (const step of engine.synthesis(text, file)) {
    const stdin = typeof step.stdin === "function" ? step.stdin(stdout) : step.stdin
    const ran = await $.process.run(step.argv, { stdin, timeoutMs: SYNTH_TIMEOUT_MS })
    if (ran.exitCode !== 0) {
      throw new Error(`${step.argv[0]} exited ${ran.exitCode}: ${(ran.stderr || ran.stdout).trim().slice(0, 200)}`)
    }
    stdout = ran.stdout
  }
}

/** ● when the engine answers now, ○ when it is down or not set up. */
async function answerMark($: EngineInterface, engine: LoadedEngine): Promise<string> {
  if (engine.probe === undefined) return "○"
  const probed = await $.process.run(engine.probe, { timeoutMs: 5_000 }).catch(() => undefined)
  return probed?.exitCode === 0 ? "●" : "○"
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

/** A choice as a text listing shows it: its id, then its name where it has one. */
function optionLine(option: PickerOption): string {
  return option.label === undefined ? `  ${option.value}` : `  ${option.value}: ${option.label}`
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
