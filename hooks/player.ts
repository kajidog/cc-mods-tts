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

/** streamPlayCommand played nothing: the source wrote no WAV (an engine without streaming, one that is down), or ffmpeg is missing. */
export const STREAM_REFUSED = 74
/** What streamPlayCommand writes to stderr beside STREAM_REFUSED: a player that exits 74 itself is not taken for a refusal. */
const STREAM_MARK = "tts-stream:"

/** Whether streamPlayCommand works with this player: ffplay reads a pipe, and only a Unix shell runs the script. */
export function canStream(player: string, isWindows: boolean): boolean {
  return player === "ffplay" && !isWindows
}

/** Whether a stream exited having played nothing, so the clip is to be synthesized to a file instead. */
export function isStreamRefused(code: number | null, stderr: string): boolean {
  return code === STREAM_REFUSED && stderr.includes(`${STREAM_MARK} refused`)
}

/** Whether the source of a stream that had begun to play failed (or stalled past the limit), cutting the speech short. */
export function isStreamFailed(code: number | null, stderr: string): boolean {
  return code !== 0 && stderr.includes(`${STREAM_MARK} failed`)
}

/** Whether the source of a stream that began to play has ended, the engine done with it, though the speech may still be playing. */
export function isStreamSynthesized(stderr: string): boolean {
  return stderr.includes(`${STREAM_MARK} synthesized`)
}

/**
 * Plays the WAV that `source` writes to stdout as it comes, through ffmpeg (the leading pause cut,
 * the volume, the padding prepareAudioCommand gives a file) into ffplay. Its stdin goes to `source`.
 * The processes talk through FIFOs beside `file` rather than a pipeline, so a stop can kill each one.
 * Exits STREAM_REFUSED when `source` writes anything but a WAV, before anything is played; a source
 * still running after `limitSeconds` is stopped, as synthesis to a file is.
 */
export function streamPlayCommand(file: string, volume: number, source: string[], limitSeconds: number): string[] {
  const filter = `silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,volume=${volume},apad=pad_dur=${TAIL_PADDING_SECONDS}`
  const fifos = '"$f.in" "$f.mid" "$f.out"'
  const refuse = `echo "${STREAM_MARK} refused" >&2; exit ${STREAM_REFUSED}`
  const noBuffer = "-probesize 32 -analyzeduration 0"
  return ["sh", "-c", [
    "f=$1; shift",
    `command -v ffmpeg >/dev/null && rm -f ${fifos} "$f.no" && mkfifo ${fifos} || { ${refuse}; }`,
    "s= g= t= p= w=",
    // ffmpeg stopped gently writes its trailer to a FIFO no one reads, and never exits.
    `trap 'kill -9 $t 2>/dev/null; kill $s $g $p $w 2>/dev/null; rm -f ${fifos} "$f.no"; exit 143' TERM INT HUP`,
    // An asynchronous command reads /dev/null unless its stdin is redirected.
    "exec 3<&0",
    `"$@" <&3 >"$f.in" & s=$!`,
    // Its sleep is killed with it, rather than left to run out.
    `{ sleep ${limitSeconds} & z=$!; trap 'kill $z; exit' TERM; wait $z && kill $s; } 2>/dev/null & w=$!`,
    // Passes the source on once it opens as a WAV; anything else (an error body, nothing) is a refusal.
    `{ [ "$(dd bs=1 count=4 2>/dev/null)" = RIFF ] || { : >"$f.no"; exit; }; printf RIFF; cat && echo "${STREAM_MARK} synthesized" >&2; } <"$f.in" >"$f.mid" & g=$!`,
    `ffmpeg -loglevel error -y ${noBuffer} -f wav -i "$f.mid" -af "${filter}" -f wav "$f.out" & t=$!`,
    `ffplay -nodisp -autoexit -loglevel error ${noBuffer} -fflags nobuffer -f wav "$f.out" & p=$!`,
    "wait $s; sc=$?",
    "kill $w 2>/dev/null",
    // ffmpeg that failed may never have opened its output, leaving ffplay waiting for a writer.
    "wait $t || kill $p 2>/dev/null",
    "wait $p; pc=$?",
    "wait $g",
    `[ -e "$f.no" ] && { rm -f ${fifos} "$f.no"; ${refuse}; }`,
    `rm -f ${fifos}`,
    `[ $sc -ne 0 ] && { echo "${STREAM_MARK} failed $sc" >&2; exit $sc; }`,
    "exit $pc",
  ].join("\n"), "tts-stream", file, ...source]
}

/**
 * PowerShell that plays the wav at `path` (a PowerShell expression) to its end. The file goes in
 * as a stream: SoundPlayer given a \\wsl.localhost path with capitals plays nothing, without error.
 */
function soundPlayerScript(path: string, variable = "$"): string {
  const stream = `${variable}stream`
  return `${stream} = [IO.File]::OpenRead(${path}); try { (New-Object Media.SoundPlayer ${stream}).PlaySync() } finally { ${stream}.Dispose() }`
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
        soundPlayerScript("$file"),
      ].join("; "))
      // WSL: Windows reads the file through its \\wsl.localhost path.
      return shell(
        // `\$` keeps sh from expanding PowerShell's variable.
        `${scaleFile}exec powershell.exe -NoProfile -NonInteractive -Command "${soundPlayerScript(`'$(wslpath -w "$1")'`, "\\$")}"`,
      )
    default:
      return [player, file]
  }
}
