/** One choice of a picker: `value` is what the matching `/tts` command takes. */
export type PickerOption = { value: string; label?: string }

/** The settings a `/tts` command or the picker changes. */
export type Setting = "mode" | "engine" | "voice" | "speed" | "volume"

/** What a pick in the picker does: save a setting, or replay a block of the conversation. */
export type PickerAction = Setting | "replay"

/** What the picker pane offers: what a pick does, its choices, the one in use. */
export type Picker = {
  action: PickerAction
  title: string
  options: PickerOption[]
  value: string
  /** Omitted when opened: start on the page containing the current value. */
  page?: number
}

/**
 * What this session is saying, for another mod to show; tts draws none of it.
 * idle: nothing left to say. preparing: the next sentence is being synthesized.
 * waiting: a clip waits for another session to finish. playing: a clip plays.
 */
export type SpeechState = {
  state: "idle" | "preparing" | "waiting" | "playing"
  /** The sentence waiting or playing, as sent to the engine; null otherwise. */
  text: string | null
}

/** The engine in use, for another mod to show; `status` is "off" while tts is off. */
export type EngineState = {
  name: string
  voice: string
  status: "checking" | "ok" | "down" | "unset" | "off"
}

declare module "claude-code" {
  interface PluginState {
    tts: {
      /** The picker a `/tts` command without a value opened last; null before any. */
      picker: Picker | null
      /** Private audio directory owned by the current module, cleaned on reload or exit. */
      audioDirectory: string | null
      /** Names this session on the floor other sessions share, so a reload keeps holding it. */
      floorId: string | null
      /** Published for other mods: what this session is saying. */
      speech: SpeechState
      /** Published for other mods: the engine in use and whether it answers. */
      engine: EngineState
    }
  }
}
