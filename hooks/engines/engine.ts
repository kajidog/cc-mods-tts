import type { PluginOptions } from "claude-code"

import type { PickerOption } from "../../types"

/**
 * One command of a synthesis: its stdin is fixed, or made from the previous
 * command's stdout (VOICEVOX's audio query feeds its synthesis).
 */
export type Step = {
  argv: string[]
  stdin?: string | ((previousStdout: string) => string)
}

/**
 * A TTS engine. Adding one: a file in this folder, its entry in `index.ts`,
 * and its name and settings in plugin.json's `userConfig`.
 */
export type Engine = {
  /** Reads this engine's settings, its own `userConfig` keys and the shared `speed`. */
  load: (options: PluginOptions, isWindows?: boolean) => LoadedEngine
}

export type LoadedEngine = {
  /** The voice in use, as `/tts` shows it. */
  voice: string
  /** Where it runs (a URL, a command), as `/tts engine` shows it. */
  location: string
  /** A command that exits 0 when the engine answers; absent while it is not set up. */
  probe?: string[]
  /**
   * The commands that write `text`, spoken, to the wav file `out`. Audio is
   * binary and the plugin environment reads text only, so requests go through
   * curl. Throws when a setting it needs is unset.
   */
  synthesis: (text: string, out: string) => Step[]
  /** What `/tts voice` lists and sets; absent for an engine without voices. */
  voices?: {
    url: string
    /** The voices in the listing's body. */
    parse: (body: string) => PickerOption[]
    /** The `value` of the voice in use. */
    current: string
    /** The `/config` key and value that select voice `id`. */
    select: (id: string) => { key: string; value: string | number }
  }
}

/** GETs `url` within a few seconds, failing on an error status. */
export function curlProbe(url: string): string[] {
  return ["curl", "-sS", "--fail", "-m", "3", url]
}

/** POSTs stdin as JSON; with `out`, the response body goes to that file. */
export function curlPost(url: string, out?: string): string[] {
  const argv = ["curl", "-sS", "--fail-with-body", "-X", "POST", url, "-H", "Content-Type: application/json"]
  return out === undefined ? argv : [...argv, "--data-binary", "@-", "-o", out]
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "")
}
