import { atom, read, update } from "claude-code"
import type { EngineInterface, Register } from "claude-code"

import type { Picker, Setting } from "../types"

import { Channel } from "./channel"
import { type Notices, type ReadMode, type TtsConfig, toConfig } from "./config"
import { DIALOG_TOOLS, dialogSpeech } from "./dialog-text"
import {
  ANSWER_PRIORITY,
  acquireCommand,
  FLOOR_LOST,
  FLOOR_TIMEOUT,
  FLOOR_YIELDED,
  floorOutcome,
  guardedPlayCommand,
  heartbeatCommand,
  NOTICE_PRIORITY,
  releaseCommand,
  STREAM_PRIORITY,
} from "./floor"
import { type EngineName, ENGINES, type LoadedEngine } from "./engines"
import { type Pin, PINS_KEY, type Pins, pinnedOptions, toPins } from "./pins"
import { lastAnswer, replayBlocks, replayOptions } from "./replay"
import { removeDirectoryCommand, removeFilesCommand, tempDirectoryCommand } from "./platform"
import { findPlayerCommand, playCommand, prepareAudioCommand } from "./player"
import { SpeechProcess } from "./process"
import { type Change, MODE_LABELS, MODES, optionLine, planChange, SPEEDS, VOLUMES } from "./settings"
import { capLength, SKIPPED_CODE, type Spoken, SpeechSplitter, toSentences } from "./speech-text"

const HELP = [
  "/tts                   state: on/off, mode, engine, speed, volume",
  "/tts on | off          read replies aloud or not",
  "/tts stop              stop speech and mute the rest of this turn",
  "/tts test [text]       read a test sentence",
  "/tts replay            read the last answer again, whole",
  "/tts replay select     pick a recent block of the conversation and read it whole",
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
// Claude Code refuses a Select with more than 64 options.
const PICKER_PAGE_SIZE = 64
const picker = atom({ plugin: "tts", key: "picker" } as const, null as Picker | null)
// Survives a reload so the next module can remove the old module's audio files.
const audioDirectory = atom({ plugin: "tts", key: "audioDirectory" } as const, null as string | null)
// Survives a reload so the next module holds the floor the last one held.
const floorId = atom({ plugin: "tts", key: "floorId" } as const, null as string | null)

/** Irodori runs diffusion with a concurrency of 1, so one request can take minutes. */
const SYNTH_TIMEOUT_MS = 300_000
/** How often a session holding the floor while it synthesizes says it is still there. */
const FLOOR_HEARTBEAT_MS = 10_000
/** How often a session holding the floor between clips looks for a session waiting with something more urgent. */
const FLOOR_YIELD_CHECK_MS = 2_000
/** A last sentence longer than this is not said after the cut: a long line without a stop is no question. */
const MAX_TAIL = 300

/**
 * How much of one model response has been queued; past the limit the rest is dropped,
 * save its last sentence (`tail`), which `finishResponse` says: it often asks what to do next.
 */
type Budget = Origin & { spoken: number; isCut: boolean; tail?: string }

/** Where speech comes from: the streamed response (`step`), and its priority on the floor shared with other sessions. */
type Origin = { step?: number; priority: number }
const NOTICE: Origin = { priority: NOTICE_PRIORITY }

/** `cacheAs` keeps the synthesized clip at that path for the next time; `seq` numbers speech in the order queued. */
type Sentence = Origin & { text: string; generation: number; seq: number; cacheAs?: string }
type Clip = Origin & { file: string; generation: number; seq: number; isCached?: boolean }

export const register: Register = (on, options) => {
  let isWindows = false
  let config = toConfig(options)
  let engine = ENGINES[config.engine].load(options)
  let fallback = config.fallback === undefined ? undefined : ENGINES[config.fallback].load(options)
  // The working directory's pin, if any, lays its engine and voice over the options.
  let cwd = ""
  let pins: Pins = {}

  // `generation` moves on at every stop: queued work of an older one is dropped.
  let generation = 0
  let isTurnMuted = false
  // Streamed responses are numbered from 1; `unplayed` counts each one's speech not yet played or
  // dropped, under 0 for speech of no response.
  let stepCount = 0
  // The responses turns' answers came in: their clips are said with the answer's priority.
  const answerSteps = new Set<number>()
  // Responses that ended calling a tool: their text is known to come before a tool call as soon as they end.
  const toolSteps = new Set<number>()
  // The first response of this turn: an earlier turn's speech is never cut off as text before the answer.
  let turnFirstStep = 1
  const unplayed = new Map<number, number>()
  let seq = 0
  // Stream clips queued up to this `seq` are dropped: one of them waited past the limit for the floor.
  let quietThrough = 0
  // Called once nothing is left to play: a session holding the floor gives it up.
  let onAllPlayed = () => {}
  const track = (origin: Origin) => {
    const key = origin.step ?? 0
    unplayed.set(key, (unplayed.get(key) ?? 0) + 1)
    return ++seq
  }
  const settle = (origin: Origin) => {
    const key = origin.step ?? 0
    const count = (unplayed.get(key) ?? 1) - 1
    if (count > 0) unplayed.set(key, count)
    else unplayed.delete(key)
    if (unplayed.size === 0) onAllPlayed()
  }
  const priorityOf = (clip: Origin) => (clip.step !== undefined && answerSteps.has(clip.step) ? ANSWER_PRIORITY : clip.priority)
  // Stream text is known to come before a tool call once a later response starts: only then does it wait within the limit.
  // The response still streaming may turn out to be the answer, which is never dropped.
  const isBeforeTool = (clip: Clip) =>
    priorityOf(clip) === STREAM_PRIORITY && clip.step !== undefined && (clip.step < stepCount || toolSteps.has(clip.step))
  const waitLimitOf = (clip: Clip) => (isBeforeTool(clip) ? config.maxWaitSeconds : 0)
  // Names this session on the floor; kept across a reload in `floorId`.
  let floorName = Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  let releaseFloor = async () => {}
  // Restarts a wait for the floor whose clip now has another priority or limit (it became the answer,
  // or a later response showed it comes before a tool call).
  let refreshWait = () => {}
  const { isEnabled } = config
  let player: string | undefined
  const synthesisProcess = new SpeechProcess()
  const playbackProcess = new SpeechProcess()
  const floorProcess = new SpeechProcess()
  const sentences = new Channel<Sentence>()
  // The sentence being synthesized: the next clip to play, whose priority a holder between clips yields by.
  let synthesizing: Sentence | undefined
  const clips = new Channel<Clip>()
  // Notices are few and fixed: each is synthesized once per load, then replayed at once.
  const cachedNotices = new Map<string, string>()
  let directory = ""
  let noticeCount = 0
  // Set while the engine in use fails ("voicevox down"); shown beside playback until it reads again.
  let engineIssue: string | undefined
  // The blocks `/tts replay select` last offered; a pick names one by its index.
  let replayChoices: string[] = []
  // Set by session.start: probes the engine in use and shows the result.
  let recheckEngine = () => {}

  /** Rebuilds the engines from the options with this directory's pin laid over them. */
  const applyPins = (stored: Pins) => {
    pins = stored
    const effective = pinnedOptions(options, pins[cwd])
    config = toConfig(effective)
    engine = ENGINES[config.engine].load(effective, isWindows)
    fallback = config.fallback === undefined ? undefined : ENGINES[config.fallback].load(effective, isWindows)
    // Cached notices were spoken in the voice before.
    cachedNotices.clear()
    recheckEngine()
  }

  /** What saving `value` for `setting` changes, against the settings in effect here. */
  const changeOf = (setting: Setting, value: string) => planChange(setting, value, { options, config, engine, cwd, pin: pins[cwd] })

  /** Invalidates queued speech and closes the active synthesis and playback streams. */
  const stop = async () => {
    generation += 1
    await Promise.all([synthesisProcess.stop(), playbackProcess.stop(), floorProcess.stop()])
  }

  /** Queues `text` to be said next; called right after a stop, it plays first. */
  const queueNotice = (text: string) => {
    if (text === "") return
    const cached = cachedNotices.get(text)
    if (cached !== undefined) return clips.push({ ...NOTICE, file: cached, generation, seq: track(NOTICE), isCached: true })
    sentences.push({ ...NOTICE, text, generation, seq: track(NOTICE), cacheAs: `${directory}/notice-${noticeCount++}.wav` })
  }

  /** Queues `text` for synthesis, in pieces an engine takes. */
  const say = (text: string, origin: Origin) => {
    if (text === "") return
    const { step, priority } = origin
    for (const piece of capLength(text)) sentences.push({ text: piece, generation, step, priority, seq: track(origin) })
  }

  /**
   * Queues sentences; with a budget, stops before the sentence that would pass the limit
   * (never reading half of one) and says once that the rest is skipped.
   */
  const enqueue = (spoken: readonly Spoken[], budget?: Budget) => {
    const origin = budget ?? NOTICE
    for (const text of spoken) {
      // The code notice is the mod's, not the response's: it uses no budget and is never the last sentence.
      if (text === SKIPPED_CODE) {
        if (budget?.isCut !== true) say(config.notices.code, origin)
        continue
      }
      if (budget !== undefined && config.maxCharsPerTurn > 0) {
        const length = Array.from(text).length
        if (!budget.isCut && budget.spoken + length > config.maxCharsPerTurn) {
          budget.isCut = true
          say(config.notices.cut, origin)
        }
        // Each skipped sentence may be the last, so the one that passes the limit counts too.
        if (budget.isCut) {
          budget.tail = text
          continue
        }
        budget.spoken += length
      }
      say(text, origin)
    }
  }

  /** Whether sentences of a streamed response before `step` are still to be played. */
  const hasUnplayedBefore = (step: number) => [...unplayed.keys()].some(earlier => earlier >= turnFirstStep && earlier < step)

  /** Reads `text` again from the start, whole: whatever is being read stops. */
  const replay = async (text: string) => {
    await stop()
    enqueue(toSentences(text))
  }

  /** Ends a response: past the limit, says its last sentence after the cut notice. */
  const finishResponse = (budget: Budget) => {
    if (budget.tail !== undefined && Array.from(budget.tail).length <= MAX_TAIL) say(budget.tail, budget)
    budget.tail = undefined
  }

  on("session.start", async ($, e, next) => {
    const started = await next(e)
    isWindows = (await $.env.get("OS")) === "Windows_NT"
    cwd = await $.session.cwd()
    applyPins(toPins(await $.store.get(PINS_KEY)))
    player = config.player === "auto" ? (await $.process.run(findPlayerCommand(isWindows))).stdout.trim() || undefined : config.player
    if (player === undefined) $.ui.toast("tts: no audio player found (ffplay, paplay, aplay, afplay, powershell.exe)")

    directory = await prepareDirectory($, isWindows)
    floorName = (await read($, floorId)) ?? floorName
    await update($, floorId, () => floorName)
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
        if (sentence.generation !== generation) {
          settle(sentence)
          continue
        }
        synthesizing = sentence
        const file = sentence.cacheAs ?? `${directory}/${String(clipCount++).padStart(6, "0")}.wav`
        const isCurrent = () => sentence.generation === generation
        let isFallback = false
        let isHandedOff = false
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
            await $.process.run(removeFilesCommand([file], isWindows))
            continue
          }
          // Done while the clip before plays; an untrimmed clip still plays.
          await runProcess($, synthesisProcess, prepareAudioCommand(file, player, isWindows), undefined, 30_000).catch(() => undefined)
          if (!isCurrent()) {
            await $.process.run(removeFilesCommand([file, `${file}.t.wav`], isWindows))
            continue
          }
          // A notice the fallback read is kept for this time only: the engine may be back next time.
          const isCached = sentence.cacheAs !== undefined && !isFallback
          if (isCached) cachedNotices.set(sentence.text, file)
          const { generation: clipGeneration, step, priority, seq } = sentence
          clips.push({ file, generation: clipGeneration, step, priority, seq, isCached })
          isHandedOff = true
        } catch (error) {
          await $.process.run(removeFilesCommand([file], isWindows))
          if (isCurrent()) reportError(error)
        } finally {
          synthesizing = undefined
          if (!isHandedOff) settle(sentence)
        }
      }
    })()

    // One session plays at a time: the floor is a lock all sessions on this machine share.
    let isHoldingFloor = false
    // Set when the floor cannot be used (no sh, an unwritable temporary folder): play alone, as before.
    let isFloorBroken = false
    // The clip waiting for the floor with the priority and limit it waits with, and whether that wait is restarted.
    let waiting: { clip: Clip; priority: number; limit: number } | undefined
    let isRewaiting = false
    refreshWait = () => {
      if (waiting === undefined || isRewaiting) return
      const { clip, priority, limit } = waiting
      if (priorityOf(clip) === priority && waitLimitOf(clip) === limit) return
      isRewaiting = true
      void floorProcess.stop()
    }

    // Releases and heartbeats run one at a time: a heartbeat never writes the floor back after a release.
    let floorOps = Promise.resolve()
    const floorOp = (op: () => Promise<void>) => {
      const run = floorOps.then(op)
      floorOps = run.catch(() => undefined)
      return run
    }
    releaseFloor = () => floorOp(async () => {
      if (!isHoldingFloor) return
      isHoldingFloor = false
      await $.process.run(releaseCommand(isWindows, floorName)).catch(() => undefined)
    })
    // Removes a floor a wait killed mid-way may have taken; one this session does not hold is left alone.
    const giveBackFloor = () => floorOp(async () => {
      await $.process.run(releaseCommand(isWindows, floorName)).catch(() => undefined)
    })
    // The priority of the clip played last; between clips, the floor goes to a session waiting with one above
    // the next clip's, the sentence being synthesized.
    let heldPriority = STREAM_PRIORITY
    const heartbeat = (canYield = false) => floorOp(async () => {
      if (!isHoldingFloor) return
      const beat = await $.process.run(heartbeatCommand(isWindows, floorName, canYield ? (synthesizing === undefined ? heldPriority : priorityOf(synthesizing)) : undefined)).catch(() => undefined)
      if (beat?.exitCode === FLOOR_LOST || beat?.exitCode === FLOOR_YIELDED) isHoldingFloor = false
    })

    /** Keeps the floor while more of this session's speech is coming, so no other session cuts in; gives it up once none is. */
    const holdFloor = async () => {
      while (isHoldingFloor && clips.size === 0) {
        if (unplayed.size === 0) return releaseFloor()
        let timer: { cancel: () => void } | undefined
        const isBeat = await Promise.race([
          clips.ready().then(() => false),
          new Promise<boolean>(resolve => {
            onAllPlayed = () => resolve(false)
            timer = $.clock.after(FLOOR_YIELD_CHECK_MS, () => resolve(true))
          }),
        ])
        onAllPlayed = () => {}
        timer?.cancel()
        // While the next clip is synthesized, which can take minutes, a more urgent session goes first.
        if (isBeat && clips.size === 0 && unplayed.size > 0) await heartbeat(true)
      }
    }

    /** Heartbeats while `playing` runs: a clip longer than the stale limit does not lose the floor. */
    const keepFloor = async <T,>(playing: Promise<T>): Promise<T> => {
      let isPlaying = true
      let timer: { cancel: () => void } | undefined
      const schedule = () => {
        timer = $.clock.after(FLOOR_HEARTBEAT_MS, () => {
          void heartbeat().then(() => {
            if (isPlaying) schedule()
          })
        })
      }
      schedule()
      try {
        return await playing
      } finally {
        isPlaying = false
        timer?.cancel()
      }
    }

    /** Plays `clip` on the floor; drops it instead when it is stream text that waited past the limit. */
    const playClip = async (clip: Clip, player: string) => {
      const play = playCommand(player, clip.file, config.volume, isWindows)
      for (;;) {
        if (clip.generation !== generation) return
        const priority = priorityOf(clip)
        if (isBeforeTool(clip) && clip.seq <= quietThrough) return
        if (isFloorBroken || !config.sharePlayback) return void (await playbackProcess.read($.process.spawn({ argv: play })))
        if (!isHoldingFloor) {
          // Only text before a tool call waits within a limit: a notice or an answer is never dropped.
          const limit = waitLimitOf(clip)
          waiting = { clip, priority, limit }
          const waited = await floorProcess.read($.process.spawn({ argv: acquireCommand(isWindows, floorName, priority, limit) }))
          waiting = undefined
          // Cleared on every way out, a stop's included: a flag left set would keep later waits from restarting.
          const isRestarted = isRewaiting
          isRewaiting = false
          // A wait cancelled just as it took the floor still holds it: it is given up once nothing is left to say.
          if (waited.code === 0) isHoldingFloor = true
          // A stop cancels the wait along with the clip; one killed mid-way may have taken the floor, so give it back.
          if (clip.generation !== generation) {
            if (waited.code !== 0) await giveBackFloor()
            return
          }
          // The clip's priority or limit changed: wait again with the new ones.
          if (isRestarted) continue
          if (waited.code === FLOOR_TIMEOUT) {
            quietThrough = seq
            return
          }
          if (waited.code !== 0) {
            isFloorBroken = true
            $.ui.log(`tts: playback is not shared with other sessions: ${(waited.stderr || `exit ${waited.code}`).trim().slice(0, 200)}`, { to: "debug" })
            await giveBackFloor()
            continue
          }
        }
        heldPriority = priority
        const played = await keepFloor(playbackProcess.read($.process.spawn({ argv: guardedPlayCommand(isWindows, floorName, priority, play) })))
        // Handed to a session with something more urgent, or lost as stale: wait for the floor again.
        if (floorOutcome(played.code, played.stderr) !== undefined) {
          isHoldingFloor = false
          continue
        }
        return
      }
    }

    void (async () => {
      for (;;) {
        await holdFloor()
        const clip = await clips.take()
        if (clip.generation === generation && player !== undefined) {
          try {
            await playClip(clip, player)
          } catch (error) {
            if (clip.generation === generation) reportError(error)
          }
        }
        const files = [`${clip.file}.v.wav`]
        if (clip.isCached !== true) files.push(clip.file)
        await $.process.run(removeFilesCommand(files, isWindows))
        settle(clip)
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
      description: "Read replies aloud: on, off, stop, test, replay, mode, engine, voice, speed, volume, pin, unpin, config, help",
      argumentHint: "[on|off|stop|test [text]|replay [select]|mode|engine|voice|speed|volume [value]|pin|unpin|config|help]",
      // `/tts stop` has to land while a reply is still being read.
      immediate: true,
    })
    return started
  })

  on("session.end", async ($, e, next) => {
    await stop()
    await releaseFloor()
    cachedNotices.clear()
    if (directory !== "") await $.process.run(removeDirectoryCommand(directory, isWindows))
    directory = ""
    await update($, audioDirectory, () => null)
    return next(e)
  }).catch(($, e, next) => next(e))

  // /clear, resume and /branch keep this module alive without another session.start, and reset
  // $.state, which holds the directory for the next reload to remove.
  on("classic.SessionStart", { source: ["clear", "resume", "fork"] }, async ($, e, next) => {
    if (directory === "") directory = await prepareDirectory($, isWindows)
    else await update($, audioDirectory, () => directory)
    await update($, floorId, () => floorName)
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
        const text = e.args.trim().replace(/^test(?:\s+|$)/, "") || "読み上げのテストです。"
        const texts = toSentences(text)
        if (texts.length === 0) return { text: "no text to read after formatting" }
        try {
          engine.synthesis(text, "probe.wav")
        } catch (error) {
          if (fallback === undefined) return { text: error instanceof Error ? error.message : String(error) }
        }
        enqueue(texts)
        return { text: `testing ${config.engine} (the first Irodori request loads the model and can take a while)` }
      }
      case "replay": {
        const messages = await $.session.messages()
        if (rest[0] !== "select") {
          const answer = lastAnswer(messages)
          if (answer === undefined) return { text: "no answer to replay yet" }
          await replay(answer)
          return { text: "replaying the last answer" }
        }
        replayChoices = replayBlocks(messages)
        const picked = rest[1] === undefined ? undefined : replayChoices[Number(rest[1])]
        if (picked !== undefined) {
          await replay(picked)
          return { text: `replaying block ${rest[1]}` }
        }
        const options = replayOptions(replayChoices)
        if (options.length === 0) return { text: "nothing to replay yet" }
        if (await openPicker($, { action: "replay", title: "replay (newest first)", options, value: options[0]!.value })) {
          return { text: "pick a block in the pane (Esc closes it)" }
        }
        return { text: ["recent blocks, newest first (/tts replay select <n>):", ...options.map(optionLine)].join("\n") }
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
          if (await openPicker($, { action: "voice", title, options, value: voices.current })) {
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
          if (await openPicker($, { action: "mode", title: "read mode", options, value: config.mode })) {
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
          if (await openPicker($, { action: action, title: action, options: choices, value: current })) {
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
          const rows = await Promise.all(names.map(each => engineRow($, each, ENGINES[each].load(options, isWindows), config)))
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
    const { Box, Text, Select, Button } = $.ui.resolve(e)
    const page = shown.page ?? Math.floor(Math.max(0, shown.options.findIndex(option => option.value === shown.value)) / PICKER_PAGE_SIZE)
    const pages = Math.ceil(shown.options.length / PICKER_PAGE_SIZE)
    const choices = shown.options.slice(page * PICKER_PAGE_SIZE, (page + 1) * PICKER_PAGE_SIZE)
    const turnPage = (page: number) => update($, picker, () => ({ ...shown, page }))
    return (
      <Box flexDirection="column">
        <Text dimColor>{`${shown.title}: ↑↓ move, Enter picks, Esc closes`}</Text>
        {pages > 1 && (
          <Box>
            {page > 0 && <Button key="previous-page" hotkey="p" onPress={() => turnPage(page - 1)}>Previous</Button>}
            <Text dimColor>{` Page ${page + 1}/${pages} `}</Text>
            {page + 1 < pages && <Button key="next-page" hotkey="n" onPress={() => turnPage(page + 1)}>Next</Button>}
          </Box>
        )}
        <Select
          key={`${shown.action}-${page}`}
          options={choices.map(option => ({ value: option.value, label: option.label ?? option.value }))}
          value={choices.some(option => option.value === shown.value) ? shown.value : undefined}
          autoFocus
          onSelect={async value => {
            await $.ui.close({ id: PICKER_PANE })
            if (shown.action === "replay") {
              const text = replayChoices[Number(value)]
              if (text === undefined) $.ui.toast("tts: that block is gone; run /tts replay select again")
              else await replay(text)
              return
            }
            $.ui.toast(`tts: ${await commit($, changeOf(shown.action, value), applyPins)}`)
          }}
        />
      </Box>
    )
  })

  on("prompt.submit", async ($, e, next) => {
    if (config.interruptOnPrompt) await stop()
    return next(e)
  }).catch(($, e, next) => next(e))

  // Asks the model to write what reads well aloud; notify mode reads none of its text.
  on("prompt.compose", async ($, e, next) => {
    const composed = await next(e)
    if (!isEnabled || config.mode === "notify" || config.modelPrompt === "") return composed
    return { sections: [...composed.sections, { id: "tts:spoken", text: config.modelPrompt, scope: "session" as const }] }
  }).catch(($, e, next) => next(e))

  on("turn.start", async ($, e, next) => {
    // A subagent's turn, should one start here, is no new turn of the main loop: its steps are not counted.
    if (!("agentId" in e) || e.agentId === undefined) {
      isTurnMuted = false
      turnFirstStep = stepCount + 1
    }
    return next(e)
  })

  on("turn.complete", async ($, e, next) => {
    if (e.reason === "aborted" && e.agentId === undefined) await stop()
    if (isEnabled && !isTurnMuted && e.agentId === undefined) {
      // Stream: text from before the answer still waiting gives way to the answer, read from its start.
      // Once the answer is being read, nothing earlier waits and it reads on: it is never said twice.
      if (config.mode === "stream" && e.reason === "answer") {
        answerSteps.add(stepCount)
        refreshWait()
      }
      if (config.mode === "stream" && e.reason === "answer" && e.answer !== "" && hasUnplayedBefore(stepCount)) {
        await stop()
        const budget: Budget = { spoken: 0, isCut: false, priority: ANSWER_PRIORITY }
        enqueue(toSentences(e.answer), budget)
        finishResponse(budget)
      }
      if (config.mode === "final" && e.reason === "answer") {
        const budget: Budget = { spoken: 0, isCut: false, priority: ANSWER_PRIORITY }
        enqueue(toSentences(e.answer), budget)
        finishResponse(budget)
      }
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
    const budget: Budget = { spoken: 0, isCut: false, step: ++stepCount, priority: STREAM_PRIORITY }
    // Text of the response before waits as text before a tool call from now on.
    refreshWait()
    const splitter = new SpeechSplitter()
    const responseGeneration = generation
    const queueResponse = (texts: readonly Spoken[]) => {
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
        // The response's last chunk says it ends calling a tool: its text comes before one from now on.
        if (chunk.kind === "stop" && chunk.stopReason === "tool_use" && budget.step !== undefined) {
          toolSteps.add(budget.step)
          refreshWait()
        }
        yield chunk
      }
    } finally {
      // Runs even when the engine stops pulling after the last chunk: the line without a newline is said too.
      queueResponse(splitter.flush())
      if (!isTurnMuted && responseGeneration === generation) finishResponse(budget)
    }
    return stream.result
  })
}

/** Creates a temporary directory, removing the previous module's files after a reload. */
async function prepareDirectory($: EngineInterface, isWindows: boolean): Promise<string> {
  const previous = await read($, audioDirectory)
  if (previous !== null) await $.process.run(removeDirectoryCommand(previous, isWindows))
  const created = await $.process.run(tempDirectoryCommand(isWindows))
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
    engine.synthesis("", "probe.wav")
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
  const opened = await $.ui.open({ id: PICKER_PANE, title: `tts ${shown.action}`, focus: true, closeOnEscape: true, rows })
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
