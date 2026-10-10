import type { On, ProcessSpawnRequest, TurnStepResult } from "claude-code"
import { expect, test } from "claude-code/testing"

const options = { engine: "command", command: "synth {out}", player: "aplay" }
const start = { cwd: "/review", surface: "terminal" as const, isInteractive: true }
const command = (args: string) => ({ command: "tts", args, origin: { kind: "composer" as const }, presentation: { isFullscreen: false, columns: 80 } })
const completed = (answer: string) => ({ turnId: "turn", answer, reason: "answer" as const, durationMs: 1, isAborted: false })
const step = { turnId: "turn", index: 0, model: "test", messageCount: 1 }
const stepResult: TurnStepResult = { turnId: "turn", index: 0, answer: "", toolUses: [], stopReason: "end_turn", usage: null }

/** No commands or audio actually run; tests inspect the requests sent to the host. */
function host(on: On, blockedInput?: string) {
  const commands: string[][] = []
  const processes: ProcessSpawnRequest[] = []
  let directories = 0
  let onStarted: () => void = () => {}
  const started = new Promise<void>(resolve => { onStarted = resolve })
  const cancelled: string[] = []
  on("session.start", () => ({ cwd: "/review" }))
  on("session.cwd", () => ({ value: "/review" }))
  on("session.end", (_, e) => ({ sessionId: e.sessionId }))
  on("classic.SessionStart", () => ({}))
  on("store.get", () => ({ value: undefined }))
  on("command.register", () => ({ value: { command: "tts" } }))
  on("ui.status", () => ({ value: undefined }))
  on("ui.toast", () => ({ value: undefined }))
  on("ui.log", () => ({ value: undefined }))
  on("turn.start", (_, e) => ({ turnId: e.turnId }))
  on("turn.complete", (_, e) => ({ text: e.answer }))
  on("process.run", (_, e) => {
    commands.push([...e.argv])
    return { value: { exitCode: 0, stdout: e.argv[0] === "mktemp" ? `/tmp/claude-tts-test${++directories}\n` : "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("clock.after", () => new Promise<{ value: void }>(() => {}))
  on("process.spawn", async function* (_, e, next) {
    processes.push(e)
    if (blockedInput !== undefined && e.input === blockedInput) {
      onStarted()
      await new Promise<void>(resolve => next.signal.addEventListener("abort", resolve))
      cancelled.push(e.input)
      return { value: { code: null, signal: "SIGTERM" } }
    }
    return { value: { code: 0, signal: null } }
  })
  return {
    commands, processes, started, cancelled,
    /** Waits until synthesis and playback stop asking the host for anything. */
    idle: async () => {
      for (let seen = -1; seen !== commands.length + processes.length;) {
        seen = commands.length + processes.length
        await settle()
      }
    },
    spoken: () => processes.filter(e => e.argv[0] === "synth").map(e => e.input),
  }
}

// Drain promise continuations without real timers or audio.
async function settle() {
  for (let i = 0; i < 200; i++) await Promise.resolve()
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

test("the response budget caps actual characters and adds one cut notice", { options: { ...options, mode: "final" } }, async ($, on) => {
  const observed = host(on)
  await $.session.start(start)
  await $.turn.complete(completed("あ".repeat(800)))
  await observed.idle()
  await settle()
  const spoken = observed.spoken()
  expect(spoken.at(-1)).toBe("以下、省略します。")
  expect(spoken.slice(0, -1).join("").length).toBe(600)
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
