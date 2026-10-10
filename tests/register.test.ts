import type { On, ProcessSpawnRequest, TurnStepResult } from "claude-code"
import { expect, test } from "claude-code/testing"

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
  on("session.start", () => ({ cwd: "/review" }))
  on("session.cwd", () => ({ value: "/review" }))
  on("env.get", () => ({ value: isWindows ? "Windows_NT" : undefined }))
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
    let stdout = ""
    if (e.argv[0] === "mktemp") stdout = `/tmp/claude-tts-test${++directories}\n`
    else if (e.argv.at(-1)?.includes("CreateDirectory")) stdout = `C:\\Users\\日本語 Test\\Temp\\claude-tts-test${++directories}\r\n`
    else if (e.argv.at(-1)?.includes("Get-Command ffplay")) stdout = "powershell\r\n"
    return { value: { exitCode: 0, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("clock.after", () => new Promise<{ value: undefined }>(() => {}))
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

test("asks the model to write for speech while replies are read", { options: { ...options, modelPrompt: "日本語で。" } }, expectSections(["intro:x", "tts:spoken:日本語で。"]))

for (const [name, extra] of [["an empty prompt", { modelPrompt: "" }], ["notify mode", { mode: "notify" }], ["off", { enabled: false }]] as const) {
  test(`adds nothing to the system prompt with ${name}`, { options: { ...options, ...extra } }, expectSections(["intro:x"]))
}
