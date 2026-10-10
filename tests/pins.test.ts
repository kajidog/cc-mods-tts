import type { PluginOptions } from "claude-code"
import { expect, test } from "claude-code/testing"

import { pinnedOptions, toPins } from "../hooks/pins"

const options = { engine: "irodori", irodoriVoice: "a", voicevoxSpeaker: 3 } as PluginOptions

test("a pin overrides the engine and each engine's voice", async () => {
  const pinned = pinnedOptions(options, { engine: "voicevox", voices: { voicevox: "8", irodori: "b" } })
  expect(pinned).toEqual({ engine: "voicevox", irodoriVoice: "b", voicevoxSpeaker: 8 })
})

test("no pin leaves the options as they are", async () => {
  expect(pinnedOptions(options, undefined)).toBe(options)
})

test("stored pins keep only known engines", async () => {
  expect(toPins({ "/a": { engine: "voicevox", voices: {} }, "/b": { engine: "gone", voices: {} }, "/c": 1 })).toEqual({
    "/a": { engine: "voicevox", voices: {} },
  })
  expect(toPins(undefined)).toEqual({})
})
