import type { PluginOptions } from "claude-code"
import { describe, expect, test } from "claude-code/testing"

import { ENGINES } from "../hooks/engines"

const options = (values: Record<string, unknown>) => ({ speed: 1, ...values }) as PluginOptions

describe("engines", () => {
  test("command fills {out} and sends the text on stdin", async () => {
    const steps = ENGINES.command.load(options({ command: "say -o {out}" })).synthesis("こんにちは", "/tmp/a.wav")
    expect(steps).toEqual([{ argv: ["say", "-o", "/tmp/a.wav"], stdin: "こんにちは" }])
  })

  test("irodori refuses to synthesize without a voice", async () => {
    const engine = ENGINES.irodori.load(options({ irodoriUrl: "http://x/", irodoriVoice: "" }))
    expect(() => engine.synthesis("a", "/tmp/a.wav")).toThrow("irodoriVoice")
  })

  test("voicevox queries, then synthesizes with the speed", async () => {
    const engine = ENGINES.voicevox.load(options({ voicevoxUrl: "http://x/", voicevoxSpeaker: 3, speed: 1.2 }))
    const [query, synthesis] = engine.synthesis("あ", "/tmp/a.wav")
    expect(query?.argv).toContain("http://x/audio_query?speaker=3&text=%E3%81%82")
    const stdin = synthesis?.stdin as (previous: string) => string
    expect(JSON.parse(stdin('{"speedScale":1}'))).toEqual({ speedScale: 1.2 })
    expect(engine.voices?.select("8")).toEqual({ key: "tts.voicevoxSpeaker", value: 8 })
  })

  test("each engine says how to check that it answers", async () => {
    expect(ENGINES.irodori.load(options({ irodoriUrl: "http://x/" })).probe).toContain("http://x/health")
    expect(ENGINES.voicevox.load(options({ voicevoxUrl: "http://x" })).probe).toContain("http://x/version")
    expect(ENGINES.command.load(options({ command: "say -o {out}" })).probe?.at(-1)).toBe("say")
    expect(ENGINES.command.load(options({ command: "" })).probe).toBeUndefined()
  })

  test("voices parse into the options the picker offers", async () => {
    const irodori = ENGINES.irodori.load(options({ irodoriUrl: "http://x", irodoriVoice: "b" })).voices
    expect(irodori?.parse('{"data":[{"id":"a"},{"id":"b"}]}')).toEqual([{ value: "a" }, { value: "b" }])
    expect(irodori?.current).toBe("b")
    const voicevox = ENGINES.voicevox.load(options({ voicevoxUrl: "http://x", voicevoxSpeaker: 3 })).voices
    const listed = '[{"name":"ずんだもん","styles":[{"id":3,"name":"ノーマル"}]}]'
    expect(voicevox?.parse(listed)).toEqual([{ value: "3", label: "ずんだもん ノーマル" }])
    expect(voicevox?.current).toBe("3")
  })
})
