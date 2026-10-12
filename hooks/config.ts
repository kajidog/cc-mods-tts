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
  code: string
  table: string
  /** Joined to the first sentence of a block quote. */
  quote: string
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
  code: "noticeCode",
  table: "noticeTable",
  quote: "noticeQuote",
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
  /** Take turns with other sessions on the floor; false plays at once, over them. */
  sharePlayback: boolean
  /** Seconds text before a tool call waits for another session to finish; 0: no limit. */
  maxWaitSeconds: number
  interruptOnPrompt: boolean
  /** Added to the system prompt while replies are read; empty: nothing. */
  modelPrompt: string
  /** Ask for a summary line on long answers, and read only it where an answer has one. */
  summary: boolean
  notices: Notices
}

export function toConfig(options: PluginOptions): TtsConfig {
  const engine = String(options.engine)
  const fallback = String(options.fallback)
  return {
    isEnabled: options.enabled !== false,
    mode: options.mode as ReadMode,
    engine: engine in ENGINES ? (engine as EngineName) : "voicevox",
    fallback: fallback in ENGINES && fallback !== engine ? (fallback as EngineName) : undefined,
    player: String(options.player),
    volume: Number(options.volume),
    maxCharsPerTurn: Number(options.maxCharsPerTurn),
    sharePlayback: options.sharePlayback !== false,
    maxWaitSeconds: Math.max(0, Number(options.maxWaitSeconds ?? 60) || 0),
    interruptOnPrompt: options.interruptOnPrompt === true,
    modelPrompt: String(options.modelPrompt ?? "").trim(),
    summary: options.summary !== false,
    notices: Object.fromEntries(
      Object.entries(NOTICE_OPTIONS).map(([notice, option]) => [notice, String(options[option] ?? "").trim()]),
    ) as Notices,
  }
}
