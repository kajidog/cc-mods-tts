import type { PluginOptions } from "claude-code"
import { expect, test } from "claude-code/testing"

import { toConfig } from "../hooks/config"
import { ENGINES } from "../hooks/engines"
import { type Current, planChange } from "../hooks/settings"

const options = { engine: "voicevox", voicevoxSpeaker: 3, speed: 1, volume: 1 } as PluginOptions
const current: Current = { options, config: toConfig(options), engine: ENGINES.voicevox.load(options), cwd: "/work", pin: undefined }

test("a change says how the setting reads before and after", async () => {
  expect(planChange("speed", "1.5", current)).toEqual({ label: "speed", previous: "1", next: "1.5", config: { key: "tts.speed", value: 1.5 } })
  expect(planChange("mode", "loud", current)).toEqual({ error: "mode is one of stream, final, notify" })
})

test("while pinned, an engine change goes to this directory's pin", async () => {
  const pin = { engine: "voicevox" as const, voices: {} }
  const change = planChange("engine", "irodori", { ...current, pin })
  if (!("pins" in change)) throw new Error("expected a pin change")
  expect(change.label).toBe("engine (this directory)")
  expect(change.pins({ "/work": pin })).toEqual({ "/work": { engine: "irodori", voices: {} } })
})
