/** Added to the system prompt with the summary setting on: the answer opens with a line `summaryOf` finds. */
export const SUMMARY_PROMPT =
  "複数の段落になる長い回答では、ターンの最後の回答の1行目に「**要約**: 」で始まる1〜3文の要約を書いてください。" +
  "読み上げはこの要約だけになるので、耳で聞いて分かる文にし、コード・ファイルパス・表・箇条書きは入れないでください。" +
  "短い回答や、ツール呼び出しの合間の進捗報告には付けないでください。"

// `**要約**:`, `**要約:**`, `Summary:` and the like, at the start of the line.
const MARKER = /^(?:\*\*|__)?(?:要約|Summary|TL;DR)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*/i
/** A line not starting with one of these is no marker. */
const MARKER_START = /^[*_要st]/i
/** Characters of a first line enough to tell a marker; a longer one is never cut short. */
const DECIDE_LENGTH = 20

/** The summary an answer opens with, its marker removed; undefined when its first line is none. */
export function summaryOf(answer: string): string | undefined {
  const line = answer.trimStart().split("\n", 1)[0] ?? ""
  const marker = MARKER.exec(line)
  if (marker === null) return undefined
  const summary = line.slice(marker[0].length).trim()
  return summary === "" ? undefined : summary
}

/**
 * Lets streamed text through as `summaryOf` would read it: a response opening
 * with a summary line passes that line alone, any other passes whole.
 */
export class SummaryFilter {
  private head = ""
  private state: "deciding" | "summary" | "rest" | "whole" = "deciding"

  push(text: string): string {
    switch (this.state) {
      case "whole":
        return text
      case "rest":
        return ""
      case "summary": {
        const newline = text.indexOf("\n")
        if (newline < 0) return text
        this.state = "rest"
        return text.slice(0, newline + 1)
      }
      case "deciding": {
        this.head += text
        const line = this.head.trimStart()
        if (line === "") return ""
        const isLineDone = line.includes("\n") || Array.from(line).length >= DECIDE_LENGTH
        // A marker waits for what follows it: one with nothing after it on its line is no summary.
        if (!isLineDone && MARKER_START.test(line) && summaryOf(line) === undefined) return ""
        return this.decide(line)
      }
    }
  }

  /** Ends a text block: a summary ends with it, and text still held is let through. */
  flush(): string {
    const line = this.head.trimStart()
    const held = this.state === "deciding" && line !== "" ? this.decide(line) : ""
    if (this.state === "summary") this.state = "rest"
    return held
  }

  private decide(line: string): string {
    if (summaryOf(line) === undefined) {
      this.state = "whole"
      return this.head
    }
    this.state = "summary"
    return this.push(line.replace(MARKER, ""))
  }
}
