import { powershellCommand, quotePowerShell } from "./platform"

/**
 * The floor: one lock file every session on this machine shares, so only one plays at a time.
 * A session waiting for it leaves a file under `wait/` saying its priority; a holder hands the
 * floor over at the next clip to a session waiting with a higher one, and none ever stops
 * another's clip.
 */

/** Text before a tool call, which a wait past the limit drops. */
export const STREAM_PRIORITY = 0
/** A turn's answer: never dropped, said before text before a tool call. */
export const ANSWER_PRIORITY = 1
/** Notices, dialogs and what a `/tts` command reads: said first. */
export const NOTICE_PRIORITY = 2

/** acquireCommand gave up: the wait passed its limit. */
export const FLOOR_TIMEOUT = 3
/** guardedPlayCommand handed the floor to a session waiting with a higher priority, and played nothing. */
export const FLOOR_YIELDED = 75
/** guardedPlayCommand found the floor taken: this session lost it as stale. Nothing played. */
export const FLOOR_LOST = 76
/**
 * What guardedPlayCommand writes to stderr beside FLOOR_YIELDED or FLOOR_LOST: a player that
 * exits with the same status is not taken for the floor.
 */
export const FLOOR_MARK = "tts-floor:"

/** Whether a guarded play handed the floor over or found it lost, rather than played. */
export function floorOutcome(code: number | null, stderr: string): "yielded" | "lost" | undefined {
  if (!stderr.includes(FLOOR_MARK)) return undefined
  return code === FLOOR_YIELDED ? "yielded" : code === FLOOR_LOST ? "lost" : undefined
}

/** Seconds without a heartbeat after which a holder counts as gone (a crash, a killed session). */
const STALE_HOLDER = 60
/** Seconds after which a waiter that stopped refreshing its file counts as gone. */
const STALE_WAITER = 5
/** Seconds after which a takeover a waiter died during counts as gone. */
const STALE_TAKEOVER = 10

// Unix: the shared directory is the user's own; `set -C` makes creating the lock file atomic.
const SH_PRELUDE = [
  `dir="\${TMPDIR:-/tmp}/claude-tts-floor-$(id -u)"`,
  `mkdir -p "$dir/wait" && chmod 700 "$dir" || exit 1`,
  `valid() { case $1 in ''|*[!0-9]*) return 1;; esac; }`,
  // Whether a session other than `$id` waits, freshly, with a priority above `$prio`; drops stale waiters.
  `higher() { for f in "$dir"/wait/*; do [ -f "$f" ] && [ "$f" != "$dir/wait/$id" ] || continue; read -r p t < "$f" 2>/dev/null; valid "$p" && valid "$t" || continue; if [ $(($1 - t)) -gt ${STALE_WAITER} ]; then rm -f "$f"; elif [ "$p" -gt "$prio" ]; then return 0; fi; done; return 1; }`,
  `owner() { o=; b=; [ -f "$dir/floor" ] && read -r o b < "$dir/floor" 2>/dev/null; }`,
  `beat() { echo "$id $1" > "$dir/floor.$id" && mv -f "$dir/floor.$id" "$dir/floor"; }`,
  // Whether the floor's holder is gone: no heartbeat for a while, or a file it never finished writing that is old.
  `stale() { owner; if valid "$b"; then [ $(($1 - b)) -gt ${STALE_HOLDER} ]; else [ -n "$(find "$dir/floor" -mmin +${Math.ceil(STALE_HOLDER / 60)} 2>/dev/null)" ]; fi; }`,
  // Removes a stale floor one waiter at a time, looking again under the takeover lock:
  // a floor another waiter took meanwhile is fresh, and stays.
  `takeover() { if (set -C; echo "$1" > "$dir/takeover") 2>/dev/null; then stale "$1" && rm -f "$dir/floor"; rm -f "$dir/takeover"; else read -r t < "$dir/takeover" 2>/dev/null; valid "$t" && [ $(($1 - t)) -gt ${STALE_TAKEOVER} ] && rm -f "$dir/takeover"; fi; }`,
  `fail() { echo "${FLOOR_MARK} $2" >&2; exit $1; }`,
].join("\n")

const PS_PRELUDE = [
  `$dir = Join-Path ([IO.Path]::GetTempPath()) 'claude-tts-floor'`,
  `$null = New-Item -ItemType Directory -Force -Path (Join-Path $dir 'wait')`,
  `$floor = Join-Path $dir 'floor'`,
  "function Now { [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }",
  "function Pair($path) { try { $s = @([IO.File]::ReadAllText($path).Trim() -split ' '); if ($s.Count -eq 2 -and $s[1] -match '^[0-9]+$') { return ,$s } } catch {}; return $null }",
  `function Higher($now) { foreach ($f in @(Get-ChildItem -LiteralPath (Join-Path $dir 'wait') -File -ErrorAction SilentlyContinue)) { if ($f.Name -eq $id) { continue }; $s = Pair $f.FullName; if ($null -eq $s -or $s[0] -notmatch '^[0-9]+$') { continue }; if ($now - [long]$s[1] -gt ${STALE_WAITER}) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue } elseif ([int]$s[0] -gt $prio) { return $true } }; return $false }`,
  "function Beat($now) { try { [IO.File]::WriteAllText($floor, \"$id $now\") } catch {} }",
  `function Stale($now) { $o = Pair $floor; if ($null -ne $o) { return ($now - [long]$o[1] -gt ${STALE_HOLDER}) }; $f = Get-Item -LiteralPath $floor -ErrorAction SilentlyContinue; return ($null -ne $f -and ([DateTime]::UtcNow - $f.LastWriteTimeUtc).TotalSeconds -gt ${STALE_HOLDER}) }`,
  "function Create($path, $text) { try { $file = [IO.File]::Open($path, 'CreateNew', 'Write'); $bytes = [Text.Encoding]::ASCII.GetBytes($text); $file.Write($bytes, 0, $bytes.Length); $file.Dispose(); return $true } catch [IO.IOException] { return $false } }",
  `function Takeover($now) { $t = Join-Path $dir 'takeover'; if (Create $t "$now") { try { if (Stale $now) { Remove-Item -LiteralPath $floor -Force -ErrorAction SilentlyContinue } } finally { Remove-Item -LiteralPath $t -Force -ErrorAction SilentlyContinue } } else { $s = ''; try { $s = [IO.File]::ReadAllText($t).Trim() } catch {}; if ($s -match '^[0-9]+$' -and $now - [long]$s -gt ${STALE_TAKEOVER}) { Remove-Item -LiteralPath $t -Force -ErrorAction SilentlyContinue } } }`,
  `function Fail($code, $what) { [Console]::Error.WriteLine("${FLOOR_MARK} $what"); exit $code }`,
].join("; ")

const sh = (script: string, args: (string | number)[]) => ["sh", "-c", `${SH_PRELUDE}\n${script}`, "tts-floor", ...args.map(String)]
const ps = (id: string, priority: number, script: string) =>
  powershellCommand(`$id = ${quotePowerShell(id)}; $prio = ${priority}; ${PS_PRELUDE}; ${script}`)

/**
 * Waits for the floor; exits 0 once held, FLOOR_TIMEOUT after `limitSeconds` (0: no limit).
 * Steps aside while a session waits with a higher priority, and takes the floor from a holder gone stale.
 */
export function acquireCommand(isWindows: boolean, id: string, priority: number, limitSeconds: number): string[] {
  // A fraction of a second is still a limit: 0 alone waits without one.
  const limit = Math.max(0, Math.ceil(limitSeconds))
  if (isWindows) return ps(id, priority, [
    `$limit = ${limit}; $start = Now; $w = Join-Path (Join-Path $dir 'wait') $id`,
    "function Leave($code) { Remove-Item -LiteralPath $w -Force -ErrorAction SilentlyContinue; exit $code }",
    "while ($true) {",
    "$now = Now; try { [IO.File]::WriteAllText($w, \"$prio $now\") } catch {}",
    "$o = Pair $floor; if ($null -ne $o -and $o[0] -eq $id) { Leave 0 }",
    "if (Stale $now) { Takeover $now }",
    "if (-not (Higher $now) -and (Create $floor \"$id $now\")) { Leave 0 }",
    `if ($limit -gt 0 -and $now - $start -ge $limit) { Leave ${FLOOR_TIMEOUT} }`,
    "Start-Sleep -Milliseconds 200 }",
  ].join("; "))
  return sh([
    `id=$1 prio=$2 limit=$3 w="$dir/wait/$1" start=$(date +%s)`,
    `trap 'rm -f "$w"; exit 143' HUP INT TERM`,
    "while :; do",
    `  now=$(date +%s); echo "$prio $now" > "$w"`,
    `  owner; if [ "$o" = "$id" ]; then rm -f "$w"; exit 0; fi`,
    `  stale "$now" && takeover "$now"`,
    `  if ! higher "$now" && (set -C; echo "$id $now" > "$dir/floor") 2>/dev/null; then rm -f "$w"; exit 0; fi`,
    `  if [ "$limit" -gt 0 ] && [ $((now - start)) -ge "$limit" ]; then rm -f "$w"; exit ${FLOOR_TIMEOUT}; fi`,
    "  sleep 0.2",
    "done",
  ].join("\n"), [id, priority, limit])
}

/** Gives the floor up, if this session holds it. */
export function releaseCommand(isWindows: boolean, id: string): string[] {
  if (isWindows) return ps(id, 0, "$o = Pair $floor; if ($null -ne $o -and $o[0] -eq $id) { Remove-Item -LiteralPath $floor -Force -ErrorAction SilentlyContinue }; exit 0")
  return sh(`id=$1; owner; [ "$o" = "$id" ] && rm -f "$dir/floor"; exit 0`, [id])
}

/** Says the holder is still here while it synthesizes; exits FLOOR_LOST when it no longer holds the floor. */
export function heartbeatCommand(isWindows: boolean, id: string): string[] {
  if (isWindows) return ps(id, 0, `$o = Pair $floor; if ($null -eq $o -or $o[0] -ne $id) { exit ${FLOOR_LOST} }; Beat (Now); exit 0`)
  return sh(`id=$1; owner; [ "$o" = "$id" ] || exit ${FLOOR_LOST}; beat "$(date +%s)"`, [id])
}

/**
 * Plays `play` while holding the floor, in the same process: first hands the floor over to a
 * session waiting with a higher priority (FLOOR_YIELDED) and checks it is still held (FLOOR_LOST).
 */
export function guardedPlayCommand(isWindows: boolean, id: string, priority: number, play: string[]): string[] {
  if (isWindows) {
    const guard = [
      `$o = Pair $floor; if ($null -eq $o -or $o[0] -ne $id) { Fail ${FLOOR_LOST} 'lost' }`,
      `$now = Now; if (Higher $now) { Remove-Item -LiteralPath $floor -Force -ErrorAction SilentlyContinue; Fail ${FLOOR_YIELDED} 'yielded' }`,
      "Beat $now",
    ].join("; ")
    // A PowerShell player already runs a script: play in the same process rather than start another.
    const isPowerShell = play[0] === "powershell.exe" && play[3] === "-Command" && play.length === 5
    const body = isPowerShell ? play[4] : `& ${play.map(quotePowerShell).join(" ")}; exit $LASTEXITCODE`
    return ps(id, priority, `${guard}; ${body}`)
  }
  return sh([
    `id=$1 prio=$2; shift 2`,
    `owner; [ "$o" = "$id" ] || fail ${FLOOR_LOST} lost`,
    `now=$(date +%s); if higher "$now"; then rm -f "$dir/floor"; fail ${FLOOR_YIELDED} yielded; fi`,
    `beat "$now"`,
    `exec "$@"`,
  ].join("\n"), [id, priority, ...play])
}
