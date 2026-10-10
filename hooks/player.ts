import { powershellCommand, quotePowerShell } from "./platform"

const TAIL_PADDING_SECONDS = 0.2

/** Prints the first audio player found on this machine. */
export function findPlayerCommand(isWindows: boolean): string[] {
  if (isWindows) return powershellCommand("if (Get-Command ffplay -CommandType Application -ErrorAction SilentlyContinue) { 'ffplay' } else { 'powershell' }")
  return [
    "sh",
    "-c",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    "for p in ffplay paplay aplay afplay powershell.exe; do command -v $p >/dev/null && { echo ${p%.exe}; exit; }; done",
  ]
}

/**
 * Cuts long engine pauses, then gives ffplay and SoundPlayer time to finish speech.
 * Padding must be in the WAV: ffplay does not flush an apad filter at EOF.
 * Leaves the file as it was where ffmpeg is missing.
 */
export function prepareAudioCommand(file: string, player: string | undefined, isWindows = false): string[] {
  const edge = (keep: number) => `silenceremove=start_periods=1:start_threshold=-45dB:start_silence=${keep}`
  const padding = player === "ffplay" || player === "powershell" ? `,apad=pad_dur=${TAIL_PADDING_SECONDS}` : ""
  const filter = `${edge(0.05)},areverse,${edge(0.2)},areverse${padding}`
  if (isWindows) return powershellCommand([
    "if (-not (Get-Command ffmpeg -CommandType Application -ErrorAction SilentlyContinue)) { exit 0 }",
    `$file = ${quotePowerShell(file)}`,
    `ffmpeg -loglevel error -y -i $file -af '${filter}' ($file + '.t.wav')`,
    "if ($LASTEXITCODE -eq 0) { Move-Item -LiteralPath ($file + '.t.wav') -Destination $file -Force }",
  ].join("; "))
  return [
    "sh",
    "-c",
    `command -v ffmpeg >/dev/null || exit 0; ffmpeg -loglevel error -y -i "$1" -af "${filter}" "$1.t.wav" && mv -f "$1.t.wav" "$1"`,
    "tts-trim",
    file,
  ]
}

/**
 * Plays `file` at `volume` (1 as synthesized), preserving the cached original.
 */
export function playCommand(player: string, file: string, volume: number, isWindows = false): string[] {
  const shell = (script: string) => ["sh", "-c", script, "tts-play", file]
  const isScaled = volume !== 1
  // aplay and SoundPlayer have no volume: play a scaled copy when ffmpeg is present.
  const scaleFile = isScaled
    ? `command -v ffmpeg >/dev/null && ffmpeg -loglevel error -y -i "$1" -af volume=${volume} "$1.v.wav" && set -- "$1.v.wav"; `
    : ""
  switch (player) {
    case "ffplay":
      return ["ffplay", "-nodisp", "-autoexit", "-loglevel", "error", ...(isScaled ? ["-af", `volume=${volume}`] : []), file]
    case "paplay":
      return ["paplay", `--volume=${Math.round(65536 * volume)}`, file]
    case "afplay":
      return ["afplay", "-v", String(volume), file]
    case "aplay":
      return shell(`${scaleFile}exec aplay -q "$1"`)
    case "powershell":
      if (isWindows) return powershellCommand([
        `$file = ${quotePowerShell(file)}`,
        ...(isScaled ? [
          `if (Get-Command ffmpeg -CommandType Application -ErrorAction SilentlyContinue) { ffmpeg -loglevel error -y -i $file -af volume=${volume} ($file + '.v.wav'); if ($LASTEXITCODE -eq 0) { $file += '.v.wav' } }`,
        ] : []),
        "(New-Object Media.SoundPlayer $file).PlaySync()",
      ].join("; "))
      // WSL: Windows reads the file through its \\wsl.localhost path.
      return shell(
        `${scaleFile}exec powershell.exe -NoProfile -NonInteractive -Command "(New-Object Media.SoundPlayer '$(wslpath -w "$1")').PlaySync()"`,
      )
    default:
      return [player, file]
  }
}
