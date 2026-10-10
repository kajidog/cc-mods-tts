import { describe, expect, test } from "claude-code/testing"

import { SpeechSplitter, toSentences, toSpeakable } from "../hooks/speech-text"

const feed = (pieces: readonly string[]) => {
  const splitter = new SpeechSplitter()
  const released = pieces.map(piece => splitter.push(piece))
  return { released, rest: splitter.flush() }
}

describe("SpeechSplitter", () => {
  test("releases a sentence before its line ends", async () => {
    const { released, rest } = feed(["こんにちは。今日", "はいい天気"])
    expect(released).toEqual([["こんにちは。"], []])
    expect(rest).toEqual(["今日はいい天気"])
  })

  test("never speaks fenced code", async () => {
    const { released, rest } = feed(["見てください。\n```ts\nconst a = 1。\n", "```\n終わり。"])
    expect([...released.flat(), ...rest]).toEqual(["見てください。", "終わり。"])
  })

  test("skips tables and keeps list text", async () => {
    const { released, rest } = feed(["| a | b |\n|---|---|\n- **太字**の項目\n"])
    expect([...released.flat(), ...rest]).toEqual(["太字の項目"])
  })

  test("does not split decimals", async () => {
    const { released, rest } = feed(["version 1.5 is out. Done"])
    expect(released).toEqual([["version 1.5 is out."]])
    expect(rest).toEqual(["Done"])
  })
})

test("toSpeakable reads link text and hides URLs", async () => {
  expect(toSpeakable("## [Docs](https://example.com) と `foo.ts` を参照 https://x.y/z")).toBe("Docs と foo.ts を参照 URL")
})

test("toSentences reads a whole answer without its code", async () => {
  expect(toSentences("直しました。\n```sh\nnpm test\n```\n- 確認済み")).toEqual(["直しました。", "確認済み"])
})
