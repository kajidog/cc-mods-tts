import type { PluginOptions } from "claude-code"

import { type EngineName, ENGINES } from "./engines"

/** stream: every sentence as it streams. final: the turn's answer once it ends. notify: short notices alone. */
export type ReadMode = "stream" | "final" | "notify"

/** The lines said as notices, each a `/config` row; an empty one stays silent. */
export type Notices = {
  done: string
  error: string
  refusal: string
  question: string
  /** `{n}` is the number of questions. */
  questions: string
  plan: string
  command: string
  tool: string
  cut: string
}

const NOTICE_OPTIONS: Record<keyof Notices, string> = {
  done: "noticeDone",
  error: "noticeError",
  refusal: "noticeRefusal",
  question: "noticeQuestion",
  questions: "noticeQuestions",
  plan: "noticePlan",
  command: "noticeCommand",
  tool: "noticeTool",
  cut: "noticeCut",
}

/** The settings every engine shares; each engine reads its own in `load`. */
export type TtsConfig = {
  isEnabled: boolean
  mode: ReadMode
  engine: EngineName
  /** The engine tried when `engine` fails a sentence; undefined for none. */
  fallback: EngineName | undefined
  player: string
  volume: number
  maxCharsPerTurn: number
  interruptOnPrompt: boolean
  notices: Notices
}

export function toConfig(options: PluginOptions): TtsConfig {
  const engine = String(options.engine)
  const fallback = String(options.fallback)
  return {
    isEnabled: options.enabled !== false,
    mode: options.mode as ReadMode,
    engine: engine in ENGINES ? (engine as EngineName) : "irodori",
    fallback: fallback in ENGINES && fallback !== engine ? (fallback as EngineName) : undefined,
    player: String(options.player),
    volume: Number(options.volume),
    maxCharsPerTurn: Number(options.maxCharsPerTurn),
    interruptOnPrompt: options.interruptOnPrompt === true,
    notices: Object.fromEntries(
      Object.entries(NOTICE_OPTIONS).map(([notice, option]) => [notice, String(options[option] ?? "").trim()]),
    ) as Notices,
  }
}
