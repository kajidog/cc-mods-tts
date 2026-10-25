import type { On, ProcessSpawnRequest, SessionMessage, TurnStepResult } from "claude-code"
import { expect, test } from "claude-code/testing"

import { SUMMARY_PROMPT } from "../hooks/summary"

const options = { engine: "command", command: "synth {out}", player: "aplay" }
const start = { cwd: "/review", surface: "terminal" as const, isInteractive: true }
const command = (args: string) => ({ command: "tts", args, origin: { kind: "composer" as const }, presentation: { isFullscreen: false, columns: 80 } })
const completed = (answer: string) => ({ turnId: "turn", answer, reason: "answer" as const, durationMs: 1, isAborted: false })
const step = { turnId: "turn", index: 0, model: "test", messageCount: 1 }
const stepResult: TurnStepResult = { turnId: "turn", index: 0, answer: "", toolUses: [], stopReason: "end_turn", usage: null }

/** No commands or audio actually run; tests inspect the requests sent to the host. */
function host(on: On, blockedInput?: string, isWindows = false) {
  const commands: string[][] = []
  const processes: ProcessSpawnRequest[] = []
  let directories = 0
  let onStarted: () => void = () => {}
  const started = new Promise<void>(resolve => { onStarted = resolve })
  const cancelled: string[] = []
  // The exit code of the floor's commands; every one succeeds unless a test says otherwise.
  // "block" waits until the command is cancelled, or until `unblock` lets every blocked one succeed.
  // `isMarked` false plays a player that exits 75 or 76 itself, saying nothing of the floor.
  const unblocked: (() => void)[] = []
  const floor = {
    exit: (_kind: "acquire" | "play", _argv: readonly string[]): number | "block" => 0,
    isMarked: true,
    unblock: () => {
      for (const resolve of unblocked.splice(0)) resolve()
    },
  }
  on("session.start", () => ({ cwd: "/review" }))
  on("session.cwd", () => ({ value: "/review" }))
  on("env.get", () => ({ value: isWindows ? "Windows_NT" : undefined }))
  on("session.end", (_, e) => ({ sessionId: e.sessionId }))
  on("classic.SessionStart", () => ({}))
  on("store.get", () => ({ value: undefined }))
  on("command.register", () => ({ value: { command: "tts" } }))
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  on("ui.status", (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on("ui.toast", (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on("ui.log", () => ({ value: undefined }))
  on("turn.start", (_, e) => ({ turnId: e.turnId }))
  on("turn.complete", (_, e) => ({ text: e.answer }))
  // A test may hold the engine check's answer and the removal of audio files, and make synthesis fail.
  // `isStreamRefused` has a stream play nothing, as an engine without streaming does; `streamExit` and
  // `streamStderr` are what a stream that plays ends with, the stderr written as it starts.
  const engine = {
    check: Promise.resolve(),
    cleanup: Promise.resolve(),
    synthesisExit: 0,
    queryExit: 0,
    isStreamRefused: false,
    streamExit: 0,
    streamStderr: "",
  }
  on("process.run", async (_, e) => {
    commands.push([...e.argv])
    if (e.argv[3] === "probe") await engine.check
    if (e.argv[0] === "rm") await engine.cleanup
    let stdout = ""
    if (e.argv[0] === "mktemp") stdout = `/tmp/claude-tts-test${++directories}\n`
    else if (e.argv.at(-1)?.includes("CreateDirectory")) stdout = `C:\\Users\\日本語 Test\\Temp\\claude-tts-test${++directories}\r\n`
    else if (e.argv.at(-1)?.includes("Get-Command ffplay")) stdout = "powershell\r\n"
    return { value: { exitCode: 0, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("clock.after", () => new Promise<{ value: undefined }>(() => {}))
  // The host's clock, which a test moves on by hand.
  const clock = { now: 1_000_000 }
  on("clock.now", () => ({ value: clock.now }))
  on("process.spawn", async function* (_, e, next) {
    processes.push(e)
    if (e.argv[0] === "synth" && engine.synthesisExit !== 0) return { value: { code: engine.synthesisExit, signal: null } }
    const isStream = e.argv.includes("tts-stream")
    if (isStream && !engine.isStreamRefused && engine.streamStderr !== "") yield { stream: "stderr" as const, text: engine.streamStderr }
    const kind = floorKind(e.argv)
    if (kind !== undefined) {
      const code = floor.exit(kind, e.argv)
      if (code === "block") {
        const isReleased = await new Promise<boolean>(resolve => {
          next.signal.addEventListener("abort", () => resolve(false))
          unblocked.push(() => resolve(true))
        })
        return { value: isReleased ? { code: 0, signal: null } : { code: null, signal: "SIGTERM" } }
      }
      if (code !== 0 && kind === "play" && floor.isMarked) yield { stream: "stderr" as const, text: "tts-floor: yielded\n" }
      if (code !== 0) return { value: { code, signal: null } }
    }
    if (e.argv[0] === "curl" && e.argv.some(arg => arg.includes("/audio_query"))) {
      if (engine.queryExit !== 0) return { value: { code: engine.queryExit, signal: null } }
      yield { stream: "stdout" as const, text: '{"speedScale":1}' }
    }
    if (e.argv.includes("tts-stream") && engine.isStreamRefused) {
      yield { stream: "stderr" as const, text: "tts-stream: refused\n" }
      return { value: { code: 74, signal: null } }
    }
    if (isStream && engine.streamExit !== 0) return { value: { code: engine.streamExit, signal: null } }
    if (blockedInput !== undefined && e.input === blockedInput) {
      onStarted()
      await new Promise<void>(resolve => next.signal.addEventListener("abort", resolve))
      cancelled.push(e.input)
      return { value: { code: null, signal: "SIGTERM" } }
    }
    return { value: { code: 0, signal: null } }
  })
  return {
    commands, processes, started, cancelled, floor, clock, engine, statuses, toasts,
    /** Waits until synthesis and playback stop asking the host for anything. */
    idle: async () => {
      for (let seen = -1; seen !== commands.length + processes.length;) {
        seen = commands.length + processes.length
        await settle()
      }
    },
    spoken: () => processes.filter(e => e.argv[0] === "synth").map(e => e.input),
    /** The priority and wait limit of each wait for the floor. */
    waits: () => processes.filter(e => floorKind(e.argv) === "acquire").map(e => e.argv.slice(5, 7)),
    /** The priority of each clip played on the floor. */
    plays: () => processes.filter(e => floorKind(e.argv) === "play").map(e => e.argv[5]),
  }
}

/** Which of the floor's commands a Unix spawn is: the wait for it, or a clip played holding it. */
function floorKind(argv: readonly string[]): "acquire" | "play" | undefined {
  if (argv[0] !== "sh" || argv[3] !== "tts-floor") return undefined
  return argv[2]?.includes("trap ") ? "acquire" : "play"
}

// Drain promise continuations without real timers or audio.
async function settle() {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

for (const [count, surface] of [[64, "terminal"], [65, "terminal"], [127, "terminal"], [129, "terminal"], [127, "desktop"]] as const) {
  test(`VOICEVOX picker reaches all ${count} styles on ${surface} and saves a selection`, { options: { engine: "voicevox", voicevoxSpeaker: count - 1 } }, async ($, on) => {
    host(on)
    const saved: unknown[] = []
    on("http.fetch", () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify([
      { name: "テスト話者", styles: Array.from({ length: count }, (_, id) => ({ id, name: `スタイル${id}` })) },
    ]) } }))
    on("ui.open", () => ({ value: { isPlaced: true } }))
    on("ui.close", () => ({ value: undefined }))
    on("config.set", (_, e) => {
      saved.push({ key: e.key, value: e.value })
      return { value: e.value }
    })
    await $.session.start(start)
    expect((await $.command.run(command("voice"))).text).toBe("pick a voice in the pane (Esc closes it)")
    const ui = await $.ui.mount({
      plugin: "tts", surface, component: "Pane", requestId: "tts-picker",
      props: { title: "tts voice", isFocused: true, bodyColumns: 80, placement: "inline", scroll: { offset: 0, bodyRows: 14 }, view: {} },
    })
    expect((await ui.find({ type: "Select" }))?.props.value).toBe(String(count - 1))
    expect(await ui.find({ key: "next-page" })).toBeUndefined()
    const pages = Math.ceil(count / 64)
    for (let page = pages - 1; page > 0; page--) await ui.press({ key: "previous-page" })
    expect(await ui.find({ key: "previous-page" })).toBeUndefined()
    const reached: unknown[] = []
    for (let page = 0; page < pages; page++) {
      const select = await ui.find({ type: "Select" })
      const choices = select?.props.options as { value: string }[]
      expect(choices.length <= 64).toBe(true)
      reached.push(...choices.map(option => option.value))
      if (page + 1 < pages) await ui.press({ key: "next-page" })
    }
    expect(reached).toEqual(Array.from({ length: count }, (_, id) => String(id)))
    for (let page = pages - 1; page > 0; page--) await ui.press({ key: "previous-page" })
    await ui.select({ key: "voice-0", value: "0" })
    expect(saved).toEqual([{ key: "tts.voicevoxSpeaker", value: 0 }])
    await ui.unmount()
  })
}

test("stop mutes later stream chunks and later steps until the next turn", { options }, async ($, on) => {
  const observed = host(on)
  on("turn.step", async function* (_, e) {
    yield { kind: "text", ref: 1, index: 0, text: "一文目。" }
    yield { kind: "text", ref: 2, index: 0, text: "二文目。" }
    return { ...stepResult, turnId: e.turnId, index: e.index }
  })
  await $.session.start(start)
  const stream = $.turn.step(step)
  await stream.next()
  await observed.idle()
  await $.command.run(command("stop"))
  for await (const _ of stream) { /* Finish the response after stop. */ }
  for await (const _ of $.turn.step({ ...step, index: 1 })) { /* Another step in the same turn. */ }
  await settle()
  expect(observed.spoken()).toEqual(["一文目。"])
  await $.turn.start({ text: "next", turnId: "next" })
  for await (const _ of $.turn.step({ ...step, turnId: "next" })) { /* Speech resumes. */ }
  await observed.idle()
  await settle()
  expect(observed.spoken()).toEqual(["一文目。", "一文目。", "二文目。"])
})

test("in stream, the answer cuts off earlier text still being read and is read from its start", { options }, async ($, on) => {
  const observed = host(on, "途中です。")
  on("turn.step", async function* (_, e) {
    yield { kind: "text", ref: 1, index: 0, text: e.index === 0 ? "途中です。" : "答えです。" }
    return { ...stepResult, turnId: e.turnId, index: e.index }
  })
  await $.session.start(start)
  for await (const _ of $.turn.step(step)) { /* Text before a tool call. */ }
  await observed.started
  for await (const _ of $.turn.step({ ...step, index: 1 })) { /* The answer. */ }
  await $.turn.complete(completed("答えです。"))
  await observed.idle()
  await settle()
  expect(observed.cancelled).toEqual(["途中です。"])
  expect(observed.spoken()).toEqual(["途中です。", "答えです。"])
})

test("in stream, an answer already being read reads on and is not said twice", { options }, async ($, on) => {
  const observed = host(on, "答えです。")
  on("turn.step", async function* (_, e) {
    yield { kind: "text", ref: 1, index: 0, text: "答えです。" }
    return { ...stepResult, turnId: e.turnId, index: e.index }
  })
  await $.session.start(start)
  for await (const _ of $.turn.step(step)) { /* A turn without tool calls. */ }
  await observed.started
  await $.turn.complete(completed("答えです。"))
  await settle()
  expect(observed.cancelled).toEqual([])
  expect(observed.spoken()).toEqual(["答えです。"])
  // Release the blocked synthesis before the test ends.
  await $.command.run(command("stop"))
  await observed.idle()
})

test("stream text waits within the limit once a later response shows it comes before a tool call", { options: { ...options, maxWaitSeconds: 5 } }, async ($, on) => {
  const observed = host(on)
  // Another session reads the whole time: a limited wait gives up, an unlimited one waits on.
  observed.floor.exit = (kind, argv) => (kind !== "acquire" || argv[5] !== "0" ? 0 : argv[6] === "5" ? 3 : "block")
  on("turn.step", async function* (_, e) {
    yield { kind: "text", ref: 1, index: 0, text: e.index === 0 ? "一文目。二文目。" : "答えです。" }
    return { ...stepResult, turnId: e.turnId, index: e.index }
  })
  await $.session.start(start)
  await $.turn.start({ text: "q", turnId: "turn" })
  for await (const _ of $.turn.step(step)) { /* It may still be the answer: no limit yet. */ }
  await observed.idle()
  expect(observed.waits()).toEqual([["0", "0"]])
  for await (const _ of $.turn.step({ ...step, index: 1 })) { /* After a tool call. */ }
  await observed.idle()
  await $.turn.complete(completed("答えです。"))
  await observed.idle()
  await settle()
  // The first sentence gives up within the limit, and the one queued behind it is dropped without waiting.
  expect(observed.waits()).toEqual([["0", "0"], ["0", "5"], ["0", "0"], ["1", "0"]])
  expect(observed.plays()).toEqual(["1"])
})

test("stream text of a response that ends calling a tool waits within the limit at once", { options: { ...options, maxWaitSeconds: 5 } }, async ($, on) => {
  const observed = host(on)
  observed.floor.exit = (kind, argv) => (kind !== "acquire" || argv[5] !== "0" ? 0 : argv[6] === "5" ? 3 : "block")
  on("turn.step", async function* (_, e) {
    yield { kind: "text", ref: 1, index: 0, text: "調べます。" }
    yield { kind: "stop", ref: 2, stopReason: "tool_use", usage: null }
    return { ...stepResult, turnId: e.turnId, index: e.index, toolUses: [{ name: "Read", input: {} }], stopReason: "tool_use" as const }
  })
  await $.session.start(start)
  await $.turn.start({ text: "q", turnId: "turn" })
  for await (const _ of $.turn.step(step)) { /* The tool then runs for a while; no later response yet. */ }
  await observed.idle()
  await settle()
  // Whether it began waiting before or after the response ended, it ends up waiting within the limit.
  expect(observed.waits().at(-1)).toEqual(["0", "5"])
  expect(observed.plays()).toEqual([])
})

test("a stop during a restarted wait leaves later waits free to restart", { options: { ...options, maxWaitSeconds: 5 } }, async ($, on) => {
  const observed = host(on)
  observed.floor.exit = (kind, argv) => (kind === "acquire" && argv[5] === "0" ? "block" : 0)
  on("turn.step", async function* (_, e) {
    yield { kind: "text", ref: 1, index: 0, text: e.turnId === "first" ? "調べます。" : "答えです。" }
    if (e.turnId === "first") yield { kind: "stop", ref: 2, stopReason: "tool_use", usage: null }
    const toolUses = e.turnId === "first" ? [{ name: "Read", input: {} }] : []
    return { ...stepResult, turnId: e.turnId, index: e.index, toolUses }
  })
  await $.session.start(start)
  await $.turn.start({ text: "q1", turnId: "first" })
  const first = $.turn.step({ ...step, turnId: "first" })
  await first.next()
  await observed.idle()
  // The response ends calling a tool, restarting the wait, and a stop lands before it restarts.
  for await (const _ of first) { /* Finish the response. */ }
  await $.command.run(command("stop"))
  await observed.idle()
  await $.turn.start({ text: "q2", turnId: "second" })
  for await (const _ of $.turn.step({ ...step, turnId: "second" })) { /* The next answer, while another session reads. */ }
  await observed.idle()
  await $.turn.complete({ ...completed("答えです。"), turnId: "second" })
  await observed.idle()
  await settle()
  expect(observed.waits().at(-1)).toEqual(["1", "0"])
  expect(observed.plays()).toEqual(["1"])
})

test("a response that ends calling a tool is classified even when the consumer stops pulling at its last chunk", { options: { ...options, maxWaitSeconds: 5 } }, async ($, on) => {
  const observed = host(on)
  observed.floor.exit = (kind, argv) => (kind !== "acquire" || argv[5] !== "0" ? 0 : argv[6] === "5" ? 3 : "block")
  on("turn.step", async function* (_, e) {
    yield { kind: "text", ref: 1, index: 0, text: "調べます。" }
    yield { kind: "stop", ref: 2, stopReason: "tool_use", usage: null }
    return { ...stepResult, turnId: e.turnId, index: e.index, toolUses: [{ name: "Read", input: {} }], stopReason: "tool_use" as const }
  })
  await $.session.start(start)
  await $.turn.start({ text: "q", turnId: "turn" })
  const stream = $.turn.step(step)
  await stream.next()
  await observed.idle()
  await stream.next()
  // The last chunk is in; the consumer closes the stream instead of pulling it to its end.
  await stream.return({ ...stepResult, toolUses: [{ name: "Read", input: {} }], stopReason: "tool_use" })
  await observed.idle()
  await settle()
  expect(observed.waits().at(-1)).toEqual(["0", "5"])
})

test("a subagent's turn starting does not hide the main turn's earlier text from its answer", { options }, async ($, on) => {
  const observed = host(on, "途中です。")
  on("turn.step", async function* (_, e) {
    yield { kind: "text", ref: 1, index: 0, text: e.index === 0 ? "途中です。" : "答えです。" }
    return { ...stepResult, turnId: e.turnId, index: e.index }
  })
  await $.session.start(start)
  await $.turn.start({ text: "q", turnId: "turn" })
  for await (const _ of $.turn.step(step)) { /* Text before a tool call. */ }
  await observed.started
  // The tool is an Agent call: its subagent's turn starts.
  await $.turn.start({ text: "sub", turnId: "sub", agentId: "sub" } as Parameters<typeof $.turn.start>[0])
  for await (const _ of $.turn.step({ ...step, index: 1 })) { /* The answer. */ }
  await $.turn.complete(completed("答えです。"))
  await observed.idle()
  await settle()
  expect(observed.cancelled).toEqual(["途中です。"])
  expect(observed.spoken()).toEqual(["途中です。", "答えです。"])
})

test("an earlier turn's last response, ended in an error, is not dropped as text before a tool call", { options: { ...options, maxWaitSeconds: 5, interruptOnPrompt: false } }, async ($, on) => {
  const observed = host(on)
  observed.floor.exit = (kind, argv) => (kind !== "acquire" || argv[5] !== "0" ? 0 : argv[6] === "5" ? 3 : "block")
  on("turn.step", async function* (_, e) {
    yield { kind: "text", ref: 1, index: 0, text: e.turnId === "first" ? "失敗しました。" : "次です。" }
    return { ...stepResult, turnId: e.turnId, index: e.index }
  })
  await $.session.start(start)
  await $.turn.start({ text: "q1", turnId: "first" })
  for await (const _ of $.turn.step({ ...step, turnId: "first" })) { /* Another session reads meanwhile. */ }
  await observed.idle()
  await $.turn.complete({ ...completed("失敗しました。"), turnId: "first", reason: "error" as const })
  await $.turn.start({ text: "q2", turnId: "second" })
  for await (const _ of $.turn.step({ ...step, turnId: "second" })) { /* The next turn's first response. */ }
  await observed.idle()
  await settle()
  expect(observed.waits()).toEqual([["0", "0"]])
  // Release the blocked wait before the test ends.
  await $.command.run(command("stop"))
  await observed.idle()
})

test("an earlier turn's answer still waiting reads on when this turn's answer replaces its earlier text", { options: { ...options, interruptOnPrompt: false } }, async ($, on) => {
  const observed = host(on)
  observed.floor.exit = kind => (kind === "acquire" ? "block" : 0)
  const texts: Record<string, string> = { "first:0": "前の答えです。", "second:0": "途中です。", "second:1": "答えです。" }
  on("turn.step", async function* (_, e) {
    yield { kind: "text", ref: 1, index: 0, text: texts[`${e.turnId}:${e.index}`] ?? "" }
    return { ...stepResult, turnId: e.turnId, index: e.index }
  })
  await $.session.start(start)
  await $.turn.start({ text: "q1", turnId: "first" })
  for await (const _ of $.turn.step({ ...step, turnId: "first" })) { /* Another session reads meanwhile. */ }
  await $.turn.complete({ ...completed("前の答えです。"), turnId: "first" })
  await observed.idle()
  await $.turn.start({ text: "q2", turnId: "second" })
  for await (const _ of $.turn.step({ ...step, turnId: "second" })) { /* Text before a tool call. */ }
  for await (const _ of $.turn.step({ ...step, turnId: "second", index: 1 })) { /* The answer. */ }
  await observed.idle()
  await $.turn.complete({ ...completed("答えです。"), turnId: "second" })
  await observed.idle()
  // The other session finishes: the earlier answer, then this one read whole, and nothing of the text before it.
  observed.floor.exit = () => 0
  observed.floor.unblock()
  await observed.idle()
  await settle()
  expect(observed.plays()).toEqual(["1", "1"])
})

test("a limited wait keeps its deadline across waits again after a handover", { options: { ...options, maxWaitSeconds: 5 } }, async ($, on) => {
  const observed = host(on)
  let plays = 0
  // The first play is handed over, six seconds on: past the limit, the clip waits no more.
  observed.floor.exit = kind => {
    if (kind !== "play" || plays++ > 0) return 0
    observed.clock.now += 6_000
    return 75
  }
  on("turn.step", async function* (_, e) {
    yield { kind: "text", ref: 1, index: 0, text: "調べます。" }
    yield { kind: "stop", ref: 2, stopReason: "tool_use", usage: null }
    return { ...stepResult, turnId: e.turnId, index: e.index, toolUses: [{ name: "Read", input: {} }], stopReason: "tool_use" as const }
  })
  await $.session.start(start)
  await $.turn.start({ text: "q", turnId: "turn" })
  for await (const _ of $.turn.step(step)) { /* Text before a tool call. */ }
  await observed.idle()
  await settle()
  expect(observed.waits()).toEqual([["0", "5"]])
  expect(observed.plays()).toEqual(["0"])
})

test("a player that exits 75 itself is not taken for a handover", { options }, async ($, on) => {
  const observed = host(on)
  observed.floor.exit = kind => (kind === "play" ? 75 : 0)
  observed.floor.isMarked = false
  await $.session.start(start)
  await $.command.run(command("test 一回だけ。"))
  await observed.idle()
  await settle()
  expect(observed.waits()).toHaveLength(1)
  expect(observed.plays()).toEqual(["2"])
})

test("stream text waiting for the floor waits again as the answer once the turn ends", { options }, async ($, on) => {
  const observed = host(on)
  observed.floor.exit = (kind, argv) => (kind === "acquire" && argv[5] === "0" ? "block" : 0)
  on("turn.step", async function* (_, e) {
    yield { kind: "text", ref: 1, index: 0, text: "答えです。" }
    return { ...stepResult, turnId: e.turnId, index: e.index }
  })
  await $.session.start(start)
  await $.turn.start({ text: "q", turnId: "turn" })
  for await (const _ of $.turn.step(step)) { /* A turn without tool calls, while another session reads. */ }
  await observed.idle()
  expect(observed.waits()).toEqual([["0", "0"]])
  await $.turn.complete(completed("答えです。"))
  await observed.idle()
  await settle()
  expect(observed.waits()).toEqual([["0", "0"], ["1", "0"]])
  expect(observed.plays()).toEqual(["1"])
  expect(observed.spoken()).toEqual(["答えです。"])
})

test("an earlier turn's answer still waiting is not cut off by the next turn's answer", { options: { ...options, interruptOnPrompt: false } }, async ($, on) => {
  const observed = host(on, "前の答えです。")
  on("turn.step", async function* (_, e) {
    yield { kind: "text", ref: 1, index: 0, text: e.turnId === "first" ? "前の答えです。" : "次の答えです。" }
    return { ...stepResult, turnId: e.turnId, index: e.index }
  })
  await $.session.start(start)
  await $.turn.start({ text: "q1", turnId: "first" })
  for await (const _ of $.turn.step({ ...step, turnId: "first" })) { /* The first answer. */ }
  await observed.started
  await $.turn.complete({ ...completed("前の答えです。"), turnId: "first" })
  await $.turn.start({ text: "q2", turnId: "second" })
  for await (const _ of $.turn.step({ ...step, turnId: "second" })) { /* The next answer. */ }
  await $.turn.complete({ ...completed("次の答えです。"), turnId: "second" })
  await settle()
  expect(observed.cancelled).toEqual([])
  // Release the blocked synthesis before the test ends.
  await $.command.run(command("stop"))
  await observed.idle()
})

test("a stop that cancels a wait for the floor gives back a floor the wait may have taken", { options }, async ($, on) => {
  const observed = host(on)
  observed.floor.exit = kind => (kind === "acquire" ? "block" : 0)
  const releases = () => observed.commands.filter(argv => argv[3] === "tts-floor" && argv[2]?.includes("drop; exit 0"))
  await $.session.start(start)
  await $.command.run(command("test 待っています。"))
  await observed.idle()
  expect(observed.waits()).toHaveLength(1)
  expect(releases()).toHaveLength(0)
  await $.command.run(command("stop"))
  await observed.idle()
  await settle()
  expect(releases()).toHaveLength(1)
  expect(observed.plays()).toEqual([])
})

test("a session that hands the floor over waits for it again and plays the same clip", { options }, async ($, on) => {
  const observed = host(on)
  let plays = 0
  observed.floor.exit = kind => (kind === "play" && plays++ === 0 ? 75 : 0)
  await $.session.start(start)
  await $.command.run(command("test 一回だけ。"))
  await observed.idle()
  await settle()
  expect(observed.waits()).toEqual([["2", "0"], ["2", "0"]])
  expect(observed.plays()).toEqual(["2", "2"])
  expect(observed.spoken()).toEqual(["一回だけ。"])
})

test("with sharePlayback off, clips play at once without the floor", { options: { ...options, sharePlayback: false } }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  await $.command.run(command("test 一文目。"))
  await observed.idle()
  await settle()
  expect(observed.waits()).toEqual([])
  expect(observed.plays()).toEqual([])
  expect(observed.processes.filter(e => e.argv[0] === "sh" && e.argv[3] === "tts-play")).toHaveLength(1)
})

test("without a usable floor, clips play alone as before", { options }, async ($, on) => {
  const observed = host(on)
  observed.floor.exit = kind => (kind === "acquire" ? 1 : 0)
  await $.session.start(start)
  await $.command.run(command("test 一文目。"))
  await $.command.run(command("test 二文目。"))
  await observed.idle()
  await settle()
  expect(observed.waits()).toHaveLength(1)
  expect(observed.plays()).toEqual([])
  expect(observed.processes.filter(e => e.argv[0] === "sh" && e.argv[3] === "tts-play")).toHaveLength(2)
})

test("stop cancels an in-flight synthesis without falling back and frees the queue", {
  options: { ...options, fallback: "irodori", irodoriVoice: "sample" },
}, async ($, on) => {
  const observed = host(on, "blocked")
  await $.session.start(start)
  await $.command.run(command("test blocked"))
  await observed.started
  await $.command.run(command("stop"))
  await $.command.run(command("test fresh"))
  await observed.idle()
  await settle()
  expect(observed.cancelled).toEqual(["blocked"])
  expect(observed.spoken()).toEqual(["blocked", "fresh"])
  expect(observed.processes.some(e => e.argv[0] === "curl")).toBe(false)
})

test("the response budget stops before the sentence that passes it and adds one cut notice", { options: { ...options, mode: "final" } }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  // Five sentences of 160 characters: three fit in 600, the fourth passes.
  await $.turn.complete(completed(`${"あ".repeat(159)}。`.repeat(5)))
  await observed.idle()
  await settle()
  const spoken = observed.spoken()
  const cut = spoken.indexOf("途中を省略します。")
  expect(spoken.lastIndexOf("途中を省略します。")).toBe(cut)
  expect(spoken.slice(0, cut).map(sentence => sentence?.length)).toEqual([160, 160, 160])
})

test("past the budget, the response's last sentence is still said after the cut notice", { options: { ...options, mode: "final" } }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  await $.turn.complete(completed(`${"あ".repeat(590)}。${"い".repeat(30)}。${"う".repeat(30)}。進めますか？`))
  await observed.idle()
  await settle()
  expect(observed.spoken().slice(-2)).toEqual(["途中を省略します。", "進めますか？"])
})

test("the sentence that passes the budget is said whole when it is the last", { options: { ...options, mode: "final" } }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  await $.turn.complete(completed(`${"あ".repeat(595)}。このまま進めてもいいですか？`))
  await observed.idle()
  await settle()
  const spoken = observed.spoken()
  expect(spoken.slice(-2)).toEqual(["途中を省略します。", "このまま進めてもいいですか？"])
  expect(spoken.filter(sentence => sentence?.includes("進め"))).toHaveLength(1)
})

test("a last sentence longer than an engine takes is said whole after the cut notice", { options: { ...options, mode: "final" } }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  const last = `${"お".repeat(200)}ですか？`
  await $.turn.complete(completed(`${"あ".repeat(599)}。${"い".repeat(30)}。${last}`))
  await observed.idle()
  await settle()
  const spoken = observed.spoken()
  const cut = spoken.indexOf("途中を省略します。")
  expect(spoken.slice(cut + 1).join("")).toBe(last)
})

test("a last sentence too long to be a question is not said after the cut notice", { options: { ...options, mode: "final" } }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  await $.turn.complete(completed(`${"あ".repeat(599)}。${"い".repeat(400)}`))
  await observed.idle()
  await settle()
  expect(observed.spoken().at(-1)).toBe("途中を省略します。")
})

test("the code notice uses no budget and is never the last sentence", { options: { ...options, mode: "final" } }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  await $.turn.complete(completed(`${"あ".repeat(595)}。\n\`\`\`sh\nnpm test\n\`\`\`\n終わり。`))
  await observed.idle()
  await settle()
  expect(observed.spoken().slice(-2)).toEqual(["コードは省略します。", "終わり。"])

  await $.turn.complete(completed(`${"あ".repeat(599)}。${"い".repeat(30)}。進めますか？\n\`\`\`sh\nnpm test\n\`\`\``))
  await observed.idle()
  await settle()
  expect(observed.spoken().slice(-2)).toEqual(["途中を省略します。", "進めますか？"])
})

test("the table notice is said once per table and uses no budget", { options: { ...options, mode: "final" } }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  await $.turn.complete(completed(`${"あ".repeat(595)}。\n| a | b |\n|---|---|\n| 1 | 2 |\n終わり。`))
  await observed.idle()
  await settle()
  expect(observed.spoken().slice(-2)).toEqual(["表は省略します。", "終わり。"])
})

test("the quote notice is joined to the quote's first sentence", { options: { ...options, mode: "final" } }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  await $.turn.complete(completed("前。\n> 引いた文。\n> 続き。\n\n> | a |\n後。"))
  await observed.idle()
  await settle()
  expect(observed.spoken()).toEqual(["前。", "引用、引いた文。", "続き。", "引用、表は省略します。", "後。"])
})

test("a quoted last sentence keeps its quote notice after the cut", { options: { ...options, mode: "final" } }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  await $.turn.complete(completed(`${"あ".repeat(599)}。${"い".repeat(30)}。\n> 進めますか？`))
  await observed.idle()
  await settle()
  expect(observed.spoken().slice(-2)).toEqual(["途中を省略します。", "引用、進めますか？"])
})

test("an empty skip notice keeps the quote notice for the quote's next sentence, and only for it", { options: { ...options, mode: "final", noticeTable: "" } }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  await $.turn.complete(completed("> | a |\n> 引いた文。\n\n> | b |\n\n後。"))
  await observed.idle()
  await settle()
  expect(observed.spoken()).toEqual(["引用、引いた文。", "後。"])
})

test("a quoted last sentence up to the tail limit is said after the cut", { options: { ...options, mode: "final" } }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  await $.turn.complete(completed(`${"あ".repeat(599)}。${"い".repeat(30)}。\n> ${"う".repeat(299)}？`))
  await observed.idle()
  await settle()
  // Long sentences reach the engine in pieces.
  expect(observed.spoken().slice(-2).join("")).toBe(`引用、${"う".repeat(299)}？`)
})

test("the quote notice stays on a later quoted sentence kept as the last", { options: { ...options, mode: "final" } }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  await $.turn.complete(completed(`${"あ".repeat(599)}。${"い".repeat(30)}。\n> 最初。最後ですか？`))
  await observed.idle()
  await settle()
  expect(observed.spoken().slice(-2)).toEqual(["途中を省略します。", "引用、最後ですか？"])
})

test("test speech formats lists, brackets and paths while preserving newlines", { options }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  await $.command.run(command("test — 項目（任意）です。\n1) /home/me/日本語/main.ts:10 を確認。\n```sh\nnpm test\n```"))
  await observed.idle()
  expect(observed.spoken()).toEqual(["項目 任意 です。", "main.tsの10行目 を確認。", "コードは省略します。"])
})

test("test speech reports when formatting leaves nothing to read", { options }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  const result = await $.command.run(command("test ---"))
  await observed.idle()
  expect(result.text).toBe("no text to read after formatting")
  expect(observed.spoken()).toEqual([])
})

test("clear cleans the directory and allows speech in a fresh private directory", { options }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  await $.session.end({ reason: "clear", sessionId: "session", resume: { id: "session" } })
  expect(observed.commands).toContainEqual(["rm", "-rf", "--", "/tmp/claude-tts-test1"])
  await $.classic.SessionStart({ source: "clear" })
  await $.command.run(command("test 再開。"))
  await observed.idle()
  await settle()
  expect(observed.processes[0]?.argv[1]).toBe("/tmp/claude-tts-test2/000000.wav")
})

test("Windows auto playback and cleanup stay native across a session clear", { options: { ...options, player: "auto" } }, async ($, on) => {
  const observed = host(on, undefined, true)
  await $.session.start(start)
  await $.command.run(command("test 最初。"))
  await observed.idle()
  expect(observed.spoken()).toEqual(["最初。"])
  expect(observed.processes[0]?.argv[1]).toBe("C:\\Users\\日本語 Test\\Temp\\claude-tts-test1/000000.wav")
  expect(observed.processes.map(e => e.argv.at(-1))).toContainEqual(expect.stringContaining("Media.SoundPlayer"))
  expect(observed.commands.map(argv => argv.at(-1))).toContainEqual(expect.stringContaining("Remove-Item -LiteralPath"))
  expect(observed.commands).toContainEqual(["where.exe", "synth"])
  await $.session.end({ reason: "clear", sessionId: "session", resume: { id: "session" } })
  expect(observed.commands.map(argv => argv.at(-1))).toContainEqual(expect.stringContaining("-Recurse -Force"))
  await $.classic.SessionStart({ source: "clear" })
  await $.command.run(command("test 再開。"))
  await observed.idle()
  expect(observed.spoken()).toEqual(["最初。", "再開。"])
  expect(observed.processes.map(e => e.argv[1])).toContain("C:\\Users\\日本語 Test\\Temp\\claude-tts-test2/000001.wav")
  const argv = [...observed.commands, ...observed.processes.map(e => [...e.argv])]
  expect(argv.some(args => ["sh", "rm", "mktemp"].includes(args[0] ?? ""))).toBe(false)
  expect(argv.flat().join(" ")).not.toContain("wslpath")
})

/** A test body that composes the system prompt and checks its sections as `id:text`. */
const expectSections = (expected: string[]): NonNullable<Parameters<typeof test>[2]> => async ($, on) => {
  host(on)
  on("prompt.compose", () => ({ sections: [{ id: "intro", text: "x", scope: "shared" as const }] }))
  const { sections } = await $.prompt.compose({ model: "test", promptModel: "test", surfaces: [], tools: [], outputStyle: null, traits: [] })
  expect(sections.map(section => `${section.id}:${section.text}`)).toEqual(expected)
}

test("asks the model to write for speech while replies are read", { options: { ...options, modelPrompt: "日本語で。", summary: true } }, expectSections(["intro:x", "tts:spoken:日本語で。", `tts:summary:${SUMMARY_PROMPT}`]))

test("asks for no summary with the summary setting off", { options: { ...options, modelPrompt: "日本語で。", summary: false } }, expectSections(["intro:x", "tts:spoken:日本語で。"]))

for (const [name, extra] of [["an empty prompt and no summary", { modelPrompt: "", summary: false }], ["notify mode", { mode: "notify" }], ["off", { enabled: false }]] as const) {
  test(`adds nothing to the system prompt with ${name}`, { options: { ...options, ...extra } }, expectSections(["intro:x"]))
}

const summarized = "**要約**: 直しました。\n\n詳しくはこうです。最後に確認します。"

test("in final, an answer opening with a summary line is heard as that line alone", { options: { ...options, mode: "final", summary: true } }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  await $.turn.complete(completed(summarized))
  await observed.idle()
  await settle()
  expect(observed.spoken()).toEqual(["直しました。"])
})

test("with the summary setting off, the whole answer is read", { options: { ...options, mode: "final", summary: false } }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  await $.turn.complete(completed(summarized))
  await observed.idle()
  await settle()
  expect(observed.spoken()).toEqual(["要約: 直しました。", "詳しくはこうです。", "最後に確認します。"])
})

test("in stream, text before a tool call is read and the answer only as its summary line", { options: { ...options, summary: true } }, async ($, on) => {
  const observed = host(on)
  on("turn.step", async function* (_, e) {
    const pieces = e.index === 0 ? ["調べます。\n"] : ["**要約**: 直し", "ました。\n\n詳しくは", "こうです。"]
    for (const [ref, text] of pieces.entries()) yield { kind: "text", ref, index: 0, text }
    return { ...stepResult, turnId: e.turnId, index: e.index }
  })
  await $.session.start(start)
  for await (const _ of $.turn.step(step)) { /* Text before a tool call. */ }
  await observed.idle()
  for await (const _ of $.turn.step({ ...step, index: 1 })) { /* The answer. */ }
  await $.turn.complete(completed("**要約**: 直しました。\n\n詳しくはこうです。"))
  await observed.idle()
  await settle()
  expect(observed.spoken()).toEqual(["調べます。", "直しました。"])
})

test("in stream, the answer read again in place of earlier text is read as its summary line", { options: { ...options, summary: true } }, async ($, on) => {
  const observed = host(on, "途中です。")
  on("turn.step", async function* (_, e) {
    yield { kind: "text", ref: 1, index: 0, text: e.index === 0 ? "途中です。" : summarized }
    return { ...stepResult, turnId: e.turnId, index: e.index }
  })
  await $.session.start(start)
  for await (const _ of $.turn.step(step)) { /* Text before a tool call. */ }
  await observed.started
  for await (const _ of $.turn.step({ ...step, index: 1 })) { /* The answer. */ }
  await $.turn.complete(completed(summarized))
  await observed.idle()
  await settle()
  expect(observed.spoken()).toEqual(["途中です。", "直しました。"])
})

test("publishes what is playing and the engine in use for other mods to show", { options: { ...options, mode: "final" } }, async ($, on) => {
  const observed = host(on)
  const published: Record<string, unknown> = {}
  on("state.set", (_, e, next) => {
    published[e.key] = e.value
    return next(e)
  })
  observed.floor.exit = kind => (kind === "play" ? "block" : 0)
  await $.session.start(start)
  await settle()
  expect(published.engine).toEqual({ name: "command", voice: "synth {out}", status: "ok" })
  await $.turn.complete(completed("答えです。"))
  await observed.idle()
  expect(published.speech).toEqual({ state: "playing", text: "答えです。" })
  observed.floor.unblock()
  await observed.idle()
  await settle()
  expect(published.speech).toEqual({ state: "idle", text: null })
})

test("in stream, text before a tool call opening with a summary marker is still read whole", { options: { ...options, summary: true } }, async ($, on) => {
  const observed = host(on)
  on("turn.step", async function* (_, e) {
    yield { kind: "text", ref: 1, index: 0, text: "Summary: 調べます。\n手順はこうです。" }
    yield { kind: "stop", ref: 2, stopReason: "tool_use", usage: null }
    return { ...stepResult, turnId: e.turnId, index: e.index, toolUses: [{ name: "Read", input: {} }], stopReason: "tool_use" as const }
  })
  await $.session.start(start)
  for await (const _ of $.turn.step(step)) { /* Text before a tool call. */ }
  await observed.idle()
  await settle()
  expect(observed.spoken()).toEqual(["調べます。", "手順はこうです。"])
})

test("publishes preparing while the first sentence is synthesized", { options: { ...options, mode: "final" } }, async ($, on) => {
  const observed = host(on, "答えです。")
  const published: Record<string, unknown> = {}
  on("state.set", (_, e, next) => {
    published[e.key] = e.value
    return next(e)
  })
  await $.session.start(start)
  await $.turn.complete(completed("答えです。"))
  await observed.started
  await settle()
  expect(published.speech).toEqual({ state: "preparing", text: null })
  await $.command.run(command("stop"))
  await observed.idle()
  await settle()
  expect(published.speech).toEqual({ state: "idle", text: null })
})

test("publishes its state again after /clear resets it", { options }, async ($, on) => {
  host(on)
  const published: string[] = []
  on("state.set", (_, e, next) => {
    published.push(e.key)
    return next(e)
  })
  await $.session.start(start)
  await settle()
  published.length = 0
  await $.classic.SessionStart({ source: "clear" })
  await settle()
  expect(published).toContain("speech")
  expect(published).toContain("engine")
})

test("an engine check answering after a failed synthesis does not report the engine fine", { options: { ...options, mode: "final" } }, async ($, on) => {
  const observed = host(on)
  const published: unknown[] = []
  on("state.set", (_, e, next) => {
    if (e.key === "engine") published.push(e.value)
    return next(e)
  })
  // The check at start answers only once the synthesis has failed.
  let answerCheck = () => {}
  observed.engine.check = new Promise<void>(resolve => { answerCheck = resolve })
  observed.engine.synthesisExit = 1
  await $.session.start(start)
  await $.turn.complete(completed("答えです。"))
  await observed.idle()
  await settle()
  answerCheck()
  await settle()
  expect(published.at(-1)).toEqual({ name: "command", voice: "synth {out}", status: "down" })
})

/** Records each speech state published, latest last. */
function speechStates(on: On) {
  const states: unknown[] = []
  on("state.set", (_, e, next) => {
    if (e.key === "speech") states.push(e.value)
    return next(e)
  })
  return states
}

test("publishes preparing while the next sentence of the same response is synthesized", { options }, async ($, on) => {
  const observed = host(on, "二文目。")
  const states = speechStates(on)
  on("turn.step", async function* (_, e) {
    yield { kind: "text", ref: 1, index: 0, text: "一文目。二文目。" }
    return { ...stepResult, turnId: e.turnId, index: e.index }
  })
  await $.session.start(start)
  for await (const _ of $.turn.step(step)) { /* One response, two sentences. */ }
  await observed.started
  await observed.idle()
  expect(states.at(-1)).toEqual({ state: "preparing", text: null })
  await $.command.run(command("stop"))
  await observed.idle()
})

test("publishes preparing while the answer replacing earlier text is synthesized", { options }, async ($, on) => {
  const observed = host(on, "答えです。")
  const states = speechStates(on)
  observed.floor.exit = kind => (kind === "play" ? "block" : 0)
  on("turn.step", async function* (_, e) {
    yield { kind: "text", ref: 1, index: 0, text: e.index === 0 ? "一文目。二文目。三文目。" : "答えです。" }
    return { ...stepResult, turnId: e.turnId, index: e.index }
  })
  await $.session.start(start)
  for await (const _ of $.turn.step(step)) { /* Text before a tool call, synthesized and queued. */ }
  await observed.idle()
  expect(states.at(-1)).toEqual({ state: "playing", text: "一文目。" })
  for await (const _ of $.turn.step({ ...step, index: 1 })) { /* The answer. */ }
  await $.turn.complete(completed("答えです。"))
  await observed.started
  await observed.idle()
  await settle()
  expect(states.at(-1)).toEqual({ state: "preparing", text: null })
  await $.command.run(command("stop"))
  await observed.idle()
})

test("publishes idle once the last clip has played, before its files are removed", { options: { ...options, mode: "final" } }, async ($, on) => {
  const observed = host(on)
  const states = speechStates(on)
  let cleanUp = () => {}
  observed.engine.cleanup = new Promise<void>(resolve => { cleanUp = resolve })
  await $.session.start(start)
  await $.turn.complete(completed("答えです。"))
  await observed.idle()
  await settle()
  expect(states.at(-1)).toEqual({ state: "idle", text: null })
  expect(states).toContainEqual({ state: "playing", text: "答えです。" })
  cleanUp()
  await observed.idle()
})

test("publishes idle as soon as speech is stopped, before what was queued is cleaned up", { options: { ...options, mode: "final" } }, async ($, on) => {
  const observed = host(on)
  const states = speechStates(on)
  observed.floor.exit = kind => (kind === "play" ? "block" : 0)
  await $.session.start(start)
  await $.turn.complete(completed("答えです。"))
  await observed.idle()
  expect(states.at(-1)).toEqual({ state: "playing", text: "答えです。" })
  let cleanUp = () => {}
  observed.engine.cleanup = new Promise<void>(resolve => { cleanUp = resolve })
  await $.command.run(command("stop"))
  await settle()
  expect(states.at(-1)).toEqual({ state: "idle", text: null })
  cleanUp()
  await observed.idle()
  await settle()
  expect(states.at(-1)).toEqual({ state: "idle", text: null })
})

test("replay reads the last answer whole, past the response budget", { options: { ...options, maxCharsPerTurn: 10 } }, async ($, on) => {
  const observed = host(on)
  on("session.messages", () => ({
    value: [
      { role: "user", text: "直して", toolUses: [] },
      { role: "assistant", text: "直しました。テストも通っています。コミットしますか？", toolUses: [] },
    ],
  }))
  await $.session.start(start)
  const result = await $.command.run(command("replay"))
  await observed.idle()
  expect(result.text).toBe("replaying the last answer")
  expect(observed.spoken()).toEqual(["直しました。", "テストも通っています。", "コミットしますか？"])
})

test("replay select reads the block it names", { options }, async ($, on) => {
  const observed = host(on)
  on("session.messages", () => ({
    value: [
      { role: "assistant", text: "調べます。", toolUses: [{}] },
      { role: "user", text: "", toolUses: [], toolResults: [] },
      { role: "assistant", text: "終わりました。", toolUses: [] },
    ] as SessionMessage[],
  }))
  await $.session.start(start)
  await $.command.run(command("replay select 0"))
  await observed.idle()
  expect(observed.spoken()).toEqual(["調べます。"])
})

const voicevox = { engine: "voicevox", voicevoxUrl: "http://x", voicevoxSpeaker: 3, speed: 1.2, player: "ffplay" }
const isStream = (e: ProcessSpawnRequest) => e.argv.includes("tts-stream")
const synthesisOf = (e: ProcessSpawnRequest) => e.argv.find(arg => /\/(streaming_)?synthesis\?/.test(arg))

test("with nothing playing, a sentence plays as VOICEVOX synthesizes it, and the next waits for the engine to finish it", { options: voicevox }, async ($, on) => {
  const observed = host(on)
  observed.floor.exit = (kind, argv) => (kind === "play" && argv.includes("tts-stream") ? "block" : 0)
  await $.session.start(start)
  await $.command.run(command("test 一文目。二文目。"))
  await observed.idle()
  const [stream] = observed.processes.filter(isStream)
  expect(stream?.argv).toContain("http://x/streaming_synthesis?speaker=3&segment_length=1")
  expect(JSON.parse(stream?.input ?? "")).toEqual({ speedScale: 1.2 })
  // One request at a time: the engine is still streaming the first.
  expect(observed.processes.map(synthesisOf).filter(Boolean)).toEqual(["http://x/streaming_synthesis?speaker=3&segment_length=1"])
  observed.floor.exit = () => 0
  observed.floor.unblock()
  await observed.idle()
  await settle()
  // Never told the stream was synthesized, it waited for the first to end, and with nothing left to play streams too.
  expect(observed.processes.map(synthesisOf).filter(Boolean)).toEqual([
    "http://x/streaming_synthesis?speaker=3&segment_length=1",
    "http://x/streaming_synthesis?speaker=3&segment_length=1",
  ])
})

test("the next sentence is synthesized while the first still plays, once the engine has streamed it", { options: voicevox }, async ($, on) => {
  const observed = host(on)
  observed.engine.streamStderr = "tts-stream: synthesized\n"
  observed.floor.exit = (kind, argv) => (kind === "play" && argv.includes("tts-stream") ? "block" : 0)
  await $.session.start(start)
  await $.command.run(command("test 一文目。二文目。"))
  await observed.idle()
  expect(observed.processes.map(synthesisOf).filter(Boolean)).toEqual([
    "http://x/streaming_synthesis?speaker=3&segment_length=1",
    "http://x/synthesis?speaker=3",
  ])
  observed.floor.unblock()
  await observed.idle()
  await settle()
  const plays = observed.processes.filter(e => floorKind(e.argv) === "play")
  expect(plays.map(isStream)).toEqual([true, false])
  expect(plays[1]?.argv).toContain("ffplay")
})

test("a stream that plays notes the engine as up, and one cut short is an error", { options: voicevox }, async ($, on) => {
  const observed = host(on)
  observed.engine.synthesisExit = 7
  await $.session.start(start)
  observed.engine.streamExit = 56
  observed.engine.streamStderr = "tts-stream: failed 56\n"
  await $.command.run(command("test 一文目。"))
  await observed.idle()
  await settle()
  expect(observed.statuses.at(-1)).toBe("voicevox down")
  expect(observed.toasts).toEqual([])
  observed.engine.streamExit = 0
  observed.engine.streamStderr = ""
  await $.command.run(command("test 二文目。"))
  await observed.idle()
  await settle()
  expect(observed.statuses.at(-1)).toBeUndefined()
})

test("an engine that refuses to stream reads the sentence from a file, and twice in a row is not asked to stream again", { options: voicevox }, async ($, on) => {
  const observed = host(on)
  observed.engine.isStreamRefused = true
  await $.session.start(start)
  for (const text of ["一文目。", "二文目。", "三文目。"]) {
    await $.command.run(command(`test ${text}`))
    await observed.idle()
    await settle()
  }
  expect(observed.processes.filter(isStream).length).toBe(2)
  expect(observed.processes.map(synthesisOf).filter(Boolean)).toEqual([
    "http://x/streaming_synthesis?speaker=3&segment_length=1",
    "http://x/synthesis?speaker=3",
    "http://x/streaming_synthesis?speaker=3&segment_length=1",
    "http://x/synthesis?speaker=3",
    "http://x/synthesis?speaker=3",
  ])
  const plays = observed.processes.filter(e => floorKind(e.argv) === "play")
  expect(plays.map(isStream)).toEqual([true, false, true, false, false])
})

test("a refusal of the moment does not stop the engine streaming", { options: voicevox }, async ($, on) => {
  const observed = host(on)
  observed.engine.isStreamRefused = true
  await $.session.start(start)
  await $.command.run(command("test 一文目。"))
  await observed.idle()
  await settle()
  observed.engine.isStreamRefused = false
  for (const text of ["二文目。", "三文目。"]) {
    await $.command.run(command(`test ${text}`))
    await observed.idle()
    await settle()
  }
  observed.engine.isStreamRefused = true
  await $.command.run(command("test 四文目。"))
  await observed.idle()
  await settle()
  observed.engine.isStreamRefused = false
  await $.command.run(command("test 五文目。"))
  await observed.idle()
  await settle()
  expect(observed.processes.filter(isStream).length).toBe(5)
})

test("without ffplay, VOICEVOX reads from files", { options: { ...voicevox, player: "aplay" } }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  await $.command.run(command("test 一文目。"))
  await observed.idle()
  await settle()
  expect(observed.processes.filter(isStream)).toEqual([])
  expect(observed.processes.map(synthesisOf).filter(Boolean)).toEqual(["http://x/synthesis?speaker=3"])
})

test("an engine that fails before it streams falls back at once, not after failing again", {
  options: { ...voicevox, fallback: "command", command: "synth {out}" },
}, async ($, on) => {
  const observed = host(on)
  observed.engine.queryExit = 7
  await $.session.start(start)
  await $.command.run(command("test 一文目。"))
  await observed.idle()
  await settle()
  expect(observed.processes.filter(e => e.argv.some(arg => arg.includes("/audio_query")))).toHaveLength(1)
  expect(observed.spoken()).toEqual(["一文目。"])
  expect(observed.statuses.at(-1)).toBe("voicevox down")
})

test("a clip read from a file after a refusal leaves no trimmed copy behind", { options: voicevox }, async ($, on) => {
  const observed = host(on)
  observed.engine.isStreamRefused = true
  await $.session.start(start)
  await $.command.run(command("test 一文目。"))
  await observed.idle()
  await settle()
  const removals = observed.commands.filter(argv => argv[0] === "rm").flat()
  expect(removals.some(arg => arg.endsWith("000000.wav.t.wav"))).toBe(true)
})
