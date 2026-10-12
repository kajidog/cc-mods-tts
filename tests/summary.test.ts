import { describe, expect, test } from "claude-code/testing"

import { SummaryFilter, summaryOf } from "../hooks/summary"

const feed = (pieces: readonly string[]) => {
  const filter = new SummaryFilter()
  return [...pieces.map(piece => filter.push(piece)), filter.flush()].join("")
}

describe("summaryOf", () => {
  test("finds the summary line an answer opens with, marker removed", async () => {
    expect(summaryOf("**要約**: 直しました。\n\n詳しくは……")).toBe("直しました。")
    expect(summaryOf("\n**要約:** 直しました。")).toBe("直しました。")
    expect(summaryOf("Summary：Fixed it.\nDetails")).toBe("Fixed it.")
    expect(summaryOf("tl;dr: Fixed it.")).toBe("Fixed it.")
  })

  test("finds none past the first line or after an empty marker", async () => {
    expect(summaryOf("直しました。\n**要約**: 直しました。")).toBeUndefined()
    expect(summaryOf("**要約**:\n直しました。")).toBeUndefined()
    expect(summaryOf("要約すると、直しました。")).toBeUndefined()
  })
})

describe("SummaryFilter", () => {
  test("passes the summary line alone, across chunks", async () => {
    expect(feed(["**要", "約**: 直し", "ました。\n\n詳しくは", "……"])).toBe("直しました。\n")
  })

  test("passes a summary that ends the stream without a newline", async () => {
    expect(feed(["**要約**: 直しました。"])).toBe("直しました。")
  })

  test("passes a response without a marker whole, at once when it cannot be one", async () => {
    const filter = new SummaryFilter()
    expect(filter.push("直しました。")).toBe("直しました。")
    expect(feed(["**注意**: 消えます。", "\n続き"])).toBe("**注意**: 消えます。\n続き")
    expect(feed(["**要約**:", "\n直しました。"])).toBe("**要約**:\n直しました。")
  })

  test("holds what follows a summary, for a response that turns out to call a tool", async () => {
    const filter = new SummaryFilter()
    expect(filter.push("**要約**: 調べます。\n手順は")).toBe("調べます。\n")
    expect(filter.push("こうです。")).toBe("")
    expect(filter.flush()).toBe("")
    expect(filter.release()).toBe("手順はこうです。")
    expect(filter.release()).toBe("")
  })
})
