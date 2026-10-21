import { expect, test } from "claude-code/testing"

import {
  canStream,
  findPlayerCommand,
  isStreamFailed,
  isStreamRefused,
  isStreamSynthesized,
  playCommand,
  prepareAudioCommand,
  streamPlayCommand,
} from "../hooks/player"

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

test("pads ffplay and PowerShell WAVs after trimming on both platforms", async () => {
  for (const isWindows of [false, true]) {
    for (const player of ["ffplay", "powershell"]) {
      const prepare = prepareAudioCommand("speech.wav", player, isWindows).join(" ")
      expect(prepare).toContain("start_silence=0.2,areverse,apad=pad_dur=0.2")
      expect(playCommand(player, "speech.wav", 0.5, isWindows).join(" ")).not.toContain("apad")
    }
    for (const player of ["aplay", "paplay", "afplay", undefined]) {
      expect(prepareAudioCommand("speech.wav", player, isWindows).join(" ")).not.toContain("apad")
    }
  }
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
  expect(prepareAudioCommand(file, "powershell", true).at(-1)).toContain("Move-Item -LiteralPath")
  expect(script("powershell", 1)).toContain("wslpath")
})

test("trims the silence around speech in place, keeping a short pause", async () => {
  const [, , script, , file] = prepareAudioCommand("/tmp/a.wav", "aplay")
  expect(file).toBe("/tmp/a.wav")
  expect(script).toContain("start_silence=0.05,areverse")
  expect(script).toContain('mv -f "$1.t.wav" "$1"')
})

test("streams into ffplay through ffmpeg, which cuts the leading pause, scales and pads", async () => {
  const [shell, , script, name, file, ...source] = streamPlayCommand("/tmp/a.wav", 0.5, ["curl", "http://x"], 300)
  expect([shell, name, file, source]).toEqual(["sh", "tts-stream", "/tmp/a.wav", ["curl", "http://x"]])
  expect(script).toContain("start_silence=0.05,volume=0.5,apad=pad_dur=0.2")
  expect(script).toContain("= RIFF ]")
  expect(script).toContain("trap ")
  expect(script).toContain("sleep 300")
})

test("only ffplay on Unix streams, and only a marked 74 is a refusal", async () => {
  expect(canStream("ffplay", false)).toBe(true)
  expect(canStream("ffplay", true)).toBe(false)
  expect(canStream("aplay", false)).toBe(false)
  expect(isStreamRefused(74, "tts-stream: refused\n")).toBe(true)
  expect(isStreamRefused(74, "")).toBe(false)
  expect(isStreamRefused(1, "tts-stream: refused\n")).toBe(false)
  expect(isStreamFailed(56, "tts-stream: synthesized\ntts-stream: failed 56\n")).toBe(true)
  expect(isStreamFailed(1, "")).toBe(false)
  expect(isStreamSynthesized("tts-stream: synthesized\n")).toBe(true)
})
