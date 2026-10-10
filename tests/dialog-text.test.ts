import { expect, test } from "claude-code/testing"

import { dialogSpeech as speechWith } from "../hooks/dialog-text"

const notices = {
  done: "",
  error: "",
  refusal: "",
  question: "質問があります。",
  questions: "質問が{n}件あります。",
  plan: "",
  command: "コマンドの確認をお願いします。",
  tool: "ツールの許可をお願いします。",
  cut: "",
  code: "",
}
const dialogSpeech = (tool: string, input: unknown) => speechWith(tool, input, notices)

test("reads a single question after its notice", async () => {
  expect(dialogSpeech("AskUserQuestion", { questions: [{ question: "**本当に**いいですか？" }] })).toEqual({
    notice: "質問があります。",
    detail: ["本当にいいですか？"],
  })
})

test("counts several questions instead of reading them", async () => {
  const questions = [{ question: "一つ目？" }, { question: "二つ目？" }, { question: "三つ目？" }]
  expect(dialogSpeech("AskUserQuestion", { questions })).toEqual({ notice: "質問が3件あります。", detail: [] })
})

test("reads a Bash call's description, not its command", async () => {
  expect(dialogSpeech("Bash", { command: "rm -rf build", description: "ビルド結果を消す" }).detail).toEqual(["ビルド結果を消す"])
  expect(dialogSpeech("Bash", { command: "ls" })).toEqual({ notice: "コマンドの確認をお願いします。", detail: [] })
})

test("says only the notice for other tools", async () => {
  expect(dialogSpeech("Write", { file_path: "/a", content: "x" })).toEqual({ notice: "ツールの許可をお願いします。", detail: [] })
})

test("empty notices also silence the question and command description", async () => {
  const muted = { ...notices, question: "", command: "" }
  expect(speechWith("AskUserQuestion", { questions: [{ question: "聞こえますか？" }] }, muted)).toEqual({ notice: "", detail: [] })
  expect(speechWith("Bash", { description: "説明です。" }, muted)).toEqual({ notice: "", detail: [] })
})
