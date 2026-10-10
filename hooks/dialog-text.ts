import type { Notices } from "./config"
import { toSentences } from "./speech-text"

/** Tools whose call itself opens a dialog for the person; the rest open one only to ask permission. */
export const DIALOG_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion", "ExitPlanMode"])

/**
 * What is said as a dialog opens: `notice`, a short line from the settings
 * that is cached and plays at once (empty: none), then `detail`, synthesized
 * each time.
 */
export type DialogSpeech = { notice: string; detail: string[] }

export function dialogSpeech(tool: string, input: unknown, notices: Notices): DialogSpeech {
  const fields = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>
  switch (tool) {
    case "AskUserQuestion": {
      const questions = Array.isArray(fields.questions) ? (fields.questions as { question?: unknown }[]) : []
      // Several questions are counted, not read: the dialog shows them one at a time.
      if (questions.length > 1) return { notice: notices.questions.replaceAll("{n}", String(questions.length)), detail: [] }
      const question = questions[0]?.question
      return { notice: notices.question, detail: notices.question !== "" && typeof question === "string" ? toSentences(question) : [] }
    }
    case "ExitPlanMode":
      return { notice: notices.plan, detail: [] }
    case "Bash": {
      const { description } = fields
      return { notice: notices.command, detail: notices.command !== "" && typeof description === "string" ? toSentences(description) : [] }
    }
    default:
      return { notice: notices.tool, detail: [] }
  }
}
