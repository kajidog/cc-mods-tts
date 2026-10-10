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

  test("keeps list markers silent across every chunk boundary", async () => {
    for (const marker of ["-", "*", "+", "–", "—", "•", "1.", "12)", "- [x]"]) {
      const text = `  ${marker} 項目（任意）です。\n`
      for (let at = 1; at < text.length; at++) {
        const { released, rest } = feed([text.slice(0, at), text.slice(at)])
        expect([...released.flat(), ...rest]).toEqual(["項目 任意 です。"])
      }
    }
  })

  test("does not split decimals", async () => {
    const { released, rest } = feed(["version 1.5 is out. Done"])
    expect(released).toEqual([["version 1.5 is out."]])
    expect(rest).toEqual(["Done"])
  })

  test("keeps URL query parameters private across every chunk boundary", async () => {
    const text = "参照 https://example.com/path?token=SECRET&x=1!end\n完了。"
    for (let at = 1; at < text.length; at++) {
      const { released, rest } = feed([text.slice(0, at), text.slice(at)])
      expect([...released.flat(), ...rest]).toEqual(["参照 URL", "完了。"])
    }
  })

  test("waits for a complete Markdown link before reading its label", async () => {
    const { released, rest } = feed(["[こちら！", "](https://x.test/?token=SECRET)\n"])
    expect([...released.flat(), ...rest]).toEqual(["こちら！"])
  })

  test("only closes a fence with the same marker and enough characters", async () => {
    for (const marker of ["`", "~"]) {
      const code = `${marker.repeat(4)}md\n${marker.repeat(3)}js\nconst secret = 42;\n${marker.repeat(3)}\n${marker.repeat(4)}\n完了。`
      const { released, rest } = feed(Array.from(code))
      expect([...released.flat(), ...rest]).toEqual(["完了。"])
    }
    expect(toSentences("```js\n~~~\nsecret\n```\n完了。")).toEqual(["完了。"])
  })

  test("keeps surrogate pairs together when splitting long sentences", async () => {
    const text = `${"あ".repeat(159)}😀続き。`
    const sentences = toSentences(text)
    expect(sentences.join("")).toBe(text)
    for (const sentence of sentences) expect(() => encodeURIComponent(sentence)).not.toThrow()
  })
})

test("toSpeakable reads link text and hides URLs", async () => {
  expect(toSpeakable("## [Docs](https://example.com) と `foo.ts` を参照 https://x.y/z")).toBe("Docs と foo.ts を参照 URL")
})

test("toSentences reads a whole answer without its code", async () => {
  expect(toSentences("直しました。\n```sh\nnpm test\n```\n- 確認済み")).toEqual(["直しました。", "確認済み"])
})

test("toSpeakable reads a path as its file name and line", async () => {
  expect(toSpeakable("/home/me/repo/hooks/speech-text.ts:68 を直しました")).toBe("speech-text.tsの68行目 を直しました")
  expect(toSpeakable("`hooks/engines/voicevox.ts` を見てください。")).toBe("voicevox.ts を見てください。")
  expect(toSpeakable("~/repo/a.test.ts:12:5、./b.md#L3-L9、C:\\work\\c.json:7-10")).toBe("a.test.tsの12行目、b.mdの3から9行目、c.jsonの7から10行目")
  expect(toSpeakable("../src/index.tsx の中")).toBe("index.tsx の中")
})

test("toSpeakable shortens Unicode paths and directories containing spaces", async () => {
  expect(toSpeakable("/home/me/日本語/src/main.ts:10 を修正。")).toBe("main.tsの10行目 を修正。")
  expect(toSpeakable("`C:\\Users\\me\\My Project\\src\\main.ts:10` を修正。")).toBe("main.tsの10行目 を修正。")
  expect(toSpeakable("./docs/日本語.md:10 を参照。")).toBe("日本語.mdの10行目 を参照。")
  expect(toSpeakable("参照 `/home/me/My Project/資料.md:10` を確認。")).toBe("参照 資料.mdの10行目 を確認。")
})

test("toSpeakable removes brackets but preserves their contents and meaningful symbols", async () => {
  expect(toSpeakable("変更（任意）を保存し、「引用」と [補足] を読む。")).toBe("変更 任意 を保存し、 引用 と 補足 を読む。")
  expect(toSpeakable("-1 と 1.5、C++、C#、--help、A-B。大丈夫？")).toBe("-1 と 1.5、C++、C#、--help、A-B。大丈夫？")
})

test("toSpeakable never reads part of a relative path whose first folder has a space", async () => {
  expect(toSpeakable("My Project/src/main.ts:10 を直した")).toBe("My Project/src/main.ts:10 を直した")
  expect(toSpeakable("`My Project/src/main.ts:10` を直した")).toBe("My Project/src/main.ts:10 を直した")
  expect(toSpeakable("マイ プロジェクト/src/main.ts:10 を直した")).toBe("マイ プロジェクト/src/main.ts:10 を直した")
  expect(toSpeakable("`cat src/main.ts` を実行")).toBe("cat src/main.ts を実行")
  expect(toSpeakable("修正箇所は `hooks/foo.ts:10` です")).toBe("修正箇所は foo.tsの10行目 です")
})

test("toSpeakable never reads the tail of a path with other characters in it", async () => {
  expect(toSpeakable("`/tmp/foo&bar/src/main.ts:10` を直した")).toBe("/tmp/foo&bar/src/main.ts:10 を直した")
  expect(toSpeakable("/tmp/foo&bar/src/main.ts:10 を直した")).toBe("/tmp/foo&bar/src/main.ts:10 を直した")
  expect(toSpeakable("/tmp/foo(1/src/main.ts:10")).toBe("/tmp/foo 1/src/main.ts:10")
  expect(toSpeakable("修正（src/main.ts:10）と「/tmp/a.ts」")).toBe("修正 main.tsの10行目 と a.ts")
})

test("toSpeakable never reads a path across prose", async () => {
  expect(toSpeakable("/tmp/a.ts and src/b.ts:10")).toBe("a.ts and src/b.ts:10")
  expect(toSpeakable("/home/me/repo と src/b.ts:10 を見た")).toBe("/home/me/repo と src/b.ts:10 を見た")
  expect(toSpeakable("参照 /home/me/My Project/資料.md:10 を確認。")).toBe("参照 /home/me/My Project/資料.md:10 を確認。")
})

test("toSpeakable leaves slashes that are not clearly paths", async () => {
  for (const text of ["and/or", "1/2 と 2026/10/10", "v1.2/v1.3", "React/Next.js で作る", "TCP/IP", "e.g./i.e.", "example.com:8080/api/user.json"]) {
    expect(toSpeakable(text)).toBe(text)
  }
})
