import type { PluginOptions } from "claude-code"

import { type EngineName, ENGINES } from "./engines"

/** What a working directory pins: its engine, and the voice it chose for each engine. */
export type Pin = { engine: EngineName; voices: Partial<Record<EngineName, string>> }

/** Pins by working directory, as `$.store` keeps them. */
export type Pins = Record<string, Pin>

export const PINS_KEY = "pins"

/** The options with a directory's pin laid over them; the options alone without one. */
export function pinnedOptions(options: PluginOptions, pin: Pin | undefined): PluginOptions {
  if (pin === undefined) return options
  const pinned: Record<string, PluginOptions[string]> = { ...options, engine: pin.engine }
  for (const [name, voice] of Object.entries(pin.voices) as [EngineName, string][]) {
    const selected = ENGINES[name].load(options).voices?.select(voice)
    if (selected !== undefined) pinned[selected.key.replace(/^tts\./, "")] = selected.value
  }
  return pinned
}

/** Reads `$.store`'s value as pins, dropping what is not one. */
export function toPins(stored: unknown): Pins {
  if (typeof stored !== "object" || stored === null) return {}
  return Object.fromEntries(
    Object.entries(stored).filter(([, pin]) => typeof pin === "object" && pin !== null && (pin as Pin).engine in ENGINES),
  ) as Pins
}
