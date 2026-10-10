import { expect, test } from "claude-code/testing"

import { findPlayerCommand, playCommand, trimCommand } from "../hooks/player"

const script = (player: string, volume: number) => playCommand(player, "/tmp/a.wav", volume)[2] ?? ""

test("plays as synthesized at volume 1", async () => {
  expect(playCommand("ffplay", "/tmp/a.wav", 1)).not.toContain("-af")
  expect(script("powershell", 1)).not.toContain("ffmpeg")
})

test("scales volume in the player, or with ffmpeg where the player cannot", async () => {
  expect(playCommand("ffplay", "/tmp/a.wav", 0.5)).toContain("volume=0.5")
  expect(playCommand("paplay", "/tmp/a.wav", 0.5)).toContain("--volume=32768")
  expect(playCommand("afplay", "/tmp/a.wav", 2)).toEqual(["afplay", "-v", "2", "/tmp/a.wav"])
  expect(script("aplay", 0.5)).toContain('-af volume=0.5 "$1.v.wav"')
})

test("native Windows plays literal paths without a Unix shell or WSL path conversion", async () => {
  const file = "C:\\Users\\O'Brien 日本語\\a [1].wav"
  const command = playCommand("powershell", file, 0.5, true)
  expect(command[0]).toBe("powershell.exe")
  expect(command.at(-1)).toContain("O''Brien 日本語")
  expect(command.at(-1)).toContain("($file + '.v.wav')")
  expect(command.at(-1)).not.toContain("wslpath")
  expect(playCommand("ffplay", file, 1, true).at(-1)).toBe(file)
  expect(findPlayerCommand(true).at(-1)).not.toContain("paplay")
  expect(trimCommand(file, true).at(-1)).toContain("Move-Item -LiteralPath")
  expect(script("powershell", 1)).toContain("wslpath")
})

test("trims the silence around speech in place, keeping a short pause", async () => {
  const [, , script, , file] = trimCommand("/tmp/a.wav")
  expect(file).toBe("/tmp/a.wav")
  expect(script).toContain("start_silence=0.05,areverse")
  expect(script).toContain('mv -f "$1.t.wav" "$1"')
})
