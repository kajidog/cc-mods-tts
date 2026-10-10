import type { SessionMessage } from "claude-code"
import { describe, expect, test } from "claude-code/testing"

import { lastAnswer, replayBlocks, replayOptions } from "../hooks/replay"

const user = (text: string, isToolResult = false): SessionMessage =>
  ({ role: "user", text, toolUses: [], ...(isToolResult ? { toolResults: [] } : {}) }) as SessionMessage
const assistant = (text: string, tools = 0): SessionMessage =>
  ({ role: "assistant", text, toolUses: Array.from({ length: tools }, () => ({})) }) as SessionMessage

const conversation = [
  user("直して"),
  assistant("調べます。", 1),
  user("", true),
  assistant("", 1),
  user("", true),
  assistant("直しました。"),
  assistant("コミットはまだです。"),
  user("/tts replay"),
]

describe("replayBlocks", () => {
  test("joins what the model wrote in one go and ends it at a tool call or a user message", async () => {
    expect(replayBlocks(conversation)).toEqual(["調べます。", "直しました。\nコミットはまだです。"])
  })
})

describe("lastAnswer", () => {
  test("is the text after the last tool call, past what was typed since", async () => {
    expect(lastAnswer(conversation)).toBe("直しました。\nコミットはまだです。")
  })

  test("is undefined while the turn has written nothing after its last tool call", async () => {
    expect(lastAnswer(conversation.slice(0, 3))).toBeUndefined()
    expect(lastAnswer([])).toBeUndefined()
  })
})

describe("replayOptions", () => {
  test("lists blocks newest first by their first spoken sentence, cut to one line", async () => {
    const long = `${"あ".repeat(80)}。`
    expect(replayOptions(["```sh\nnpm test\n```\n古い。", long])).toEqual([
      { value: "1", label: `${"あ".repeat(59)}…` },
      { value: "0", label: "古い。" },
    ])
  })
})
