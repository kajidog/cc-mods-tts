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

declare module "claude-code" {
  interface PluginState {
    tts: {
      /** The picker a `/tts` command without a value opened last; null before any. */
      picker: Picker | null
      /** Private audio directory owned by the current module, cleaned on reload or exit. */
      audioDirectory: string | null
      /** Names this session on the floor other sessions share, so a reload keeps holding it. */
      floorId: string | null
    }
  }
}
