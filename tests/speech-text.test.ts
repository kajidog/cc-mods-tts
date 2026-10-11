import { describe, expect, test } from "claude-code/testing"

import { capLength, QUOTE_ENDED, QUOTED, SKIPPED_CODE, SKIPPED_TABLE, SpeechSplitter, toSentences, toSpeakable } from "../hooks/speech-text"

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

  test("never speaks fenced code, and marks once where it is skipped", async () => {
    const { released, rest } = feed(["見てください。\n```ts\nconst a = 1。\n", "```\n終わり。"])
    expect([...released.flat(), ...rest]).toEqual(["見てください。", SKIPPED_CODE, "終わり。"])
  })

  test("skips tables, marks each once, and keeps list text", async () => {
    const { released, rest } = feed(["| a | b |\n|---|---|\n| 1 | 2 |\n- **太字**の項目\n", "| c |\n|---|\n"])
    expect([...released.flat(), ...rest]).toEqual([SKIPPED_TABLE, "太字の項目", SKIPPED_TABLE])
  })

  test("marks a table split across chunks once", async () => {
    const { released, rest } = feed(["| a ", "| b |\n|--", "-|---|\n終わり。"])
    expect([...released.flat(), ...rest]).toEqual([SKIPPED_TABLE, "終わり。"])
  })

  test("marks a quote once before its first sentence, across every chunk boundary", async () => {
    const text = "前。\n> 引いた文。続き\n> 二行目。\n\n> 1. 別の引用。\n後。"
    for (let at = 1; at < text.length; at++) {
      const { released, rest } = feed([text.slice(0, at), text.slice(at)])
      expect([...released.flat(), ...rest]).toEqual(["前。", QUOTED, "引いた文。", "続き", "二行目。", QUOTE_ENDED, QUOTED, "別の引用。", QUOTE_ENDED, "後。"])
    }
  })

  test("skips tables and code in a quote, and closes the code where the quote ends", async () => {
    expect(toSentences("> | a | b |\n> |---|---|\n> 表の後。")).toEqual([QUOTED, SKIPPED_TABLE, "表の後。"])
    expect(toSentences("> ```\n> secret\n> ```\n> 後。")).toEqual([QUOTED, SKIPPED_CODE, "後。"])
    expect(toSentences("> ```\n> secret\n\n外。")).toEqual([QUOTED, SKIPPED_CODE, QUOTE_ENDED, "外。"])
    expect(toSentences("```\n> ```\nsecret\n```\n外。")).toEqual([SKIPPED_CODE, "外。"])
    expect(toSentences(">\n> 🎉\n> 本文。")).toEqual([QUOTED, "本文。"])
  })

  test("never speaks an HTML comment, across sentences, lines and every chunk boundary", async () => {
    for (const text of ["前。<!-- 読まない。まだ隠す -->後。", "前。\n<!--\n隠す。\n-->\n後。"]) {
      for (let at = 1; at < text.length; at++) {
        const { released, rest } = feed([text.slice(0, at), text.slice(at)])
        expect([...released.flat(), ...rest]).toEqual(["前。", "後。"])
      }
    }
    // Past the comment, a line is in its own quote, or none.
    expect(toSentences("前。<!-- 隠す。\n> 隠す --> 後。")).toEqual(["前。", QUOTED, "後。"])
    expect(toSentences("> 一つ目。<!--\n隠す\n--> 外。\n> 二つ目。")).toEqual([QUOTED, "一つ目。", QUOTE_ENDED, "外。", QUOTED, "二つ目。"])
    // `<!--` in a code span opens no comment, however many backticks it has.
    expect(toSentences("`<!--` で始めます。\n次。").at(-1)).toBe("次。")
  })

  test("marks a quoted table right after another table as its own", async () => {
    expect(toSentences("| a |\n|---|\n> | b |\n> |---|\n| c |\n後。")).toEqual([SKIPPED_TABLE, QUOTED, SKIPPED_TABLE, QUOTE_ENDED, SKIPPED_TABLE, "後。"])
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
      expect([...released.flat(), ...rest]).toEqual([SKIPPED_CODE, "完了。"])
    }
    expect(toSentences("```js\n~~~\nsecret\n```\n完了。")).toEqual([SKIPPED_CODE, "完了。"])
  })

  test("releases a long sentence whole", async () => {
    const text = `${"あ".repeat(300)}。`
    expect(toSentences(text)).toEqual([text])
  })
})

test("toSpeakable reads link text and hides URLs", async () => {
  expect(toSpeakable("## [Docs](https://example.com) と `foo.ts` を参照 https://x.y/z")).toBe("Docs と foo.ts を参照 URL")
})

test("toSentences reads a whole answer without its code", async () => {
  expect(toSentences("直しました。\n```sh\nnpm test\n```\n- 確認済み")).toEqual(["直しました。", SKIPPED_CODE, "確認済み"])
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

test("toSpeakable reads identifiers as separate words", async () => {
  expect(toSpeakable("`SKIPPED_CODE` と `maxCharsPerTurn` を見る")).toBe("SKIPPED CODE と max Chars Per Turn を見る")
  expect(toSpeakable("useApiClients の __init__ と snake_case")).toBe("use Api Clients の init と snake case")
  expect(toSpeakable("URLs と IDs と SQLite と WSLg と HTTPServer")).toBe("URLs と IDs と SQLite と WSLg と HTTPServer")
  expect(toSpeakable("iPhone で 3dB と macOS")).toBe("iPhone で 3dB と mac OS")
  expect(toSpeakable("VOICEVOX と URL はそのまま")).toBe("VOICEVOX と URL はそのまま")
})

test("toSpeakable reads hashes and UUIDs by their start, and leaves hex words", async () => {
  expect(toSpeakable("`c43ac55` と c43ac55d0b2e4f1a9c8e7d6b5a4f3e2d1c0b9a8f を比べる")).toBe("c43ac55 と c43ac55 を比べる")
  expect(toSpeakable("ID は 123e4567-e89b-12d3-a456-426614174000 です")).toBe("ID は 123e4567 です")
  expect(toSpeakable("deadbeefcafe と 1234567890123 と 0x1234abcd5678ef")).toBe("deadbeefcafe と 1234567890123 と 0x1234abcd5678ef")
})

test("toSpeakable drops common HTML tags, keeps their text, and leaves code and comparisons", async () => {
  expect(toSpeakable("<kbd>Ctrl</kbd>+<kbd>C</kbd> で止める<br/>次へ")).toBe("Ctrl+C で止める 次へ")
  expect(toSpeakable("<details><summary>詳細</summary> <!-- メモ -->を開く")).toBe("詳細 を開く")
  expect(toSpeakable("`<div>` と a < b > c と Promise<void>")).toBe("<div> と a < b > c と Promise<void>")
  expect(toSpeakable("``a ` <kbd>`` と <kbd>K</kbd>")).toContain("<kbd>")
  expect(toSpeakable("``a ` <kbd>`` と <kbd>K</kbd>")).toMatch(/と K$/)
})

test("capLength keeps surrogate pairs together when splitting long sentences", async () => {
  const text = `${"あ".repeat(159)}😀続き。`
  const pieces = capLength(text)
  expect(pieces.length).toBeGreaterThan(1)
  expect(pieces.join("")).toBe(text)
  for (const piece of pieces) expect(() => encodeURIComponent(piece)).not.toThrow()
})
