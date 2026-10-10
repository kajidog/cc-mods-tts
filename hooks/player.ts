/** Prints the first audio player found on this machine. */
export const FIND_PLAYER = [
  "sh",
  "-c",
  "for p in ffplay paplay aplay afplay powershell.exe; do command -v $p >/dev/null && { echo ${p%.exe}; exit; }; done",
]

/**
 * Cuts the silence engines leave around speech (Irodori: about 0.5 s before
 * and 1 s after), keeping a short pause so sentences do not run together.
 * Leaves the file as it was where ffmpeg is missing.
 */
export function trimCommand(file: string): string[] {
  const edge = (keep: number) => `silenceremove=start_periods=1:start_threshold=-45dB:start_silence=${keep}`
  return [
    "sh",
    "-c",
    `command -v ffmpeg >/dev/null || exit 0; ffmpeg -loglevel error -y -i "$1" -af "${edge(0.05)},areverse,${edge(0.2)},areverse" "$1.t.wav" && mv -f "$1.t.wav" "$1"`,
    "tts-trim",
    file,
  ]
}

/**
 * The command that plays `file` at `volume` (1 as synthesized). It prints its
 * shell's pid first and then becomes the player, so the pid stops playback.
 */
export function playCommand(player: string, file: string, volume: number): string[] {
  const shell = (script: string) => ["sh", "-c", `echo $$; ${script}`, "tts-play", file]
  const isScaled = volume !== 1
  // aplay and SoundPlayer have no volume: ffmpeg rewrites the clip first, when present.
  const scaleFile = isScaled
    ? `command -v ffmpeg >/dev/null && ffmpeg -loglevel error -y -i "$1" -af volume=${volume} "$1.v.wav" && mv -f "$1.v.wav" "$1"; `
    : ""
  switch (player) {
    case "ffplay":
      return shell(`exec ffplay -nodisp -autoexit -loglevel error ${isScaled ? `-af volume=${volume} ` : ""}"$1"`)
    case "paplay":
      return shell(`exec paplay --volume=${Math.round(65536 * volume)} "$1"`)
    case "afplay":
      return shell(`exec afplay -v ${volume} "$1"`)
    case "aplay":
      return shell(`${scaleFile}exec aplay -q "$1"`)
    case "powershell":
      // WSL: Windows reads the file through its \\wsl.localhost path.
      return shell(
        `${scaleFile}exec powershell.exe -NoProfile -NonInteractive -Command "(New-Object Media.SoundPlayer '$(wslpath -w "$1")').PlaySync()"`,
      )
    default:
      return shell(`exec ${player} "$1"`)
  }
}
