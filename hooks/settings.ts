import type { PluginOptions } from "claude-code"

import type { PickerOption, Setting } from "../types"

import type { ReadMode, TtsConfig } from "./config"
import { type EngineName, ENGINES, type LoadedEngine } from "./engines"
import type { Pin, Pins } from "./pins"

export const MODES: readonly ReadMode[] = ["stream", "final", "notify"]
export const MODE_LABELS: Record<ReadMode, string> = {
  stream: "stream  返答を一文ずつ、流れてくるそばから",
  final: "final   ターンが終わってから最終的な返答だけ",
  notify: "notify  完了・エラーなどの短い通知だけ",
}
export const SPEEDS = ["0.8", "1", "1.1", "1.2", "1.5", "2"]
export const VOLUMES = ["0.5", "0.75", "1", "1.25", "1.5"]

/** A setting change ready to save: where it goes, and how it reads before and after. */
export type Change =
  | { label: string; previous: string; next: string; config: { key: string; value: string | number } }
  | { label: string; previous: string; next: string; pins: (stored: Pins) => Pins }
  | { error: string }

/** The settings in effect, which a change is measured against. */
export type Current = { options: PluginOptions; config: TtsConfig; engine: LoadedEngine; cwd: string; pin: Pin | undefined }

/** What saving `value` for `setting` changes; while pinned, engine and voice go to the pin. */
export function planChange(setting: Setting, value: string, { options, config, engine, cwd, pin }: Current): Change {
  const pinned = (update: (base: Pin) => Pin) => (stored: Pins) => {
    const base = stored[cwd] ?? pin
    return base === undefined ? stored : { ...stored, [cwd]: update(base) }
  }
  switch (setting) {
    case "mode":
      if (!MODES.includes(value as ReadMode)) return { error: `mode is one of ${MODES.join(", ")}` }
      return { label: "mode", previous: config.mode, next: value, config: { key: "tts.mode", value } }
    case "speed":
    case "volume": {
      const scale = Number(value)
      if (!(scale > 0 && scale <= 4)) return { error: `${setting} is a number above 0, up to 4` }
      const previous = String(setting === "speed" ? options.speed : config.volume)
      return { label: setting, previous, next: String(scale), config: { key: `tts.${setting}`, value: scale } }
    }
    case "engine": {
      if (!(value in ENGINES)) return { error: `engine is one of ${Object.keys(ENGINES).join(", ")}` }
      const name = value as EngineName
      if (pin === undefined) return { label: "engine", previous: config.engine, next: name, config: { key: "tts.engine", value: name } }
      return { label: "engine (this directory)", previous: config.engine, next: name, pins: pinned(base => ({ ...base, engine: name })) }
    }
    case "voice": {
      const { voices } = engine
      if (voices === undefined) return { error: `engine=${config.engine} has no voices; set it up in /config` }
      if (pin === undefined) return { label: "voice", previous: voices.current, next: value, config: voices.select(value) }
      const name = config.engine
      return {
        label: "voice (this directory)",
        previous: voices.current,
        next: value,
        pins: pinned(base => ({ ...base, voices: { ...base.voices, [name]: value } })),
      }
    }
  }
}

/** A choice as a text listing shows it: its id, then its name where it has one. */
export function optionLine(option: PickerOption): string {
  return option.label === undefined ? `  ${option.value}` : `  ${option.value}: ${option.label}`
}
