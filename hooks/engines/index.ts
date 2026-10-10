import { command } from "./command"
import type { Engine } from "./engine"
import { irodori } from "./irodori"
import { voicevox } from "./voicevox"

export type { Engine, LoadedEngine, Step } from "./engine"

/** Every engine by the name `/tts engine` and the `engine` setting take. */
export const ENGINES = { irodori, voicevox, command } satisfies Record<string, Engine>

export type EngineName = keyof typeof ENGINES
