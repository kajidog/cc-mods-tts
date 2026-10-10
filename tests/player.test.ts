import { expect, test } from "claude-code/testing"

import { playCommand, trimCommand } from "../hooks/player"

const script = (player: string, volume: number) => playCommand(player, "/tmp/a.wav", volume)[2] ?? ""

test("plays as synthesized at volume 1", async () => {
  expect(script("ffplay", 1)).not.toContain("volume")
  expect(script("powershell", 1)).not.toContain("ffmpeg")
})

test("scales volume in the player, or with ffmpeg where the player cannot", async () => {
  expect(script("ffplay", 0.5)).toContain("-af volume=0.5")
  expect(script("paplay", 0.5)).toContain("--volume=32768")
  expect(script("afplay", 2)).toContain("-v 2")
  expect(script("aplay", 0.5)).toContain('-af volume=0.5 "$1.v.wav"')
})

test("trims the silence around speech in place, keeping a short pause", async () => {
  const [, , script, , file] = trimCommand("/tmp/a.wav")
  expect(file).toBe("/tmp/a.wav")
  expect(script).toContain("start_silence=0.05,areverse")
  expect(script).toContain('mv -f "$1.t.wav" "$1"')
})
