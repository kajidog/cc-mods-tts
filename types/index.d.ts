/** One choice of a picker: `value` is what the matching `/tts` command takes. */
export type PickerOption = { value: string; label?: string }

/** The settings a `/tts` command or the picker changes. */
export type Setting = "mode" | "engine" | "voice" | "speed" | "volume"

/** What the picker pane offers: the setting a pick saves, its choices, the one in use. */
export type Picker = { setting: Setting; title: string; options: PickerOption[]; value: string }

declare module "claude-code" {
  interface PluginState {
    tts: {
      /** The picker a `/tts` command without a value opened last; null before any. */
      picker: Picker | null
      /** Private audio directory owned by the current module, cleaned on reload or exit. */
      audioDirectory: string | null
    }
  }
}
