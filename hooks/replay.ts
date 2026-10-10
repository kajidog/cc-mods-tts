import type { SessionMessage } from "claude-code"

import type { PickerOption } from "../types"

import { toSentences } from "./speech-text"

/** How many blocks `/tts replay select` offers, newest first. */
const MAX_BLOCKS = 100
const MAX_LABEL = 60

/**
 * What the model wrote in one go: consecutive assistant text, ended by a tool
 * call (whose message's text belongs to the block) or by a user message.
 */
export function replayBlocks(messages: readonly SessionMessage[]): string[] {
  const blocks: string[] = []
  let parts: string[] = []
  const end = () => {
    if (parts.length > 0) blocks.push(parts.join("\n"))
    parts = []
  }
  for (const message of messages) {
    if (message.role === "user") {
      end()
      continue
    }
    if (message.text.trim() !== "") parts.push(message.text)
    if (message.toolUses.length > 0) end()
  }
  end()
  return blocks
}

/**
 * The turn's final answer: the assistant text after the last tool call. A
 * prompt or command typed since is passed over, so it is the answer before it.
 */
export function lastAnswer(messages: readonly SessionMessage[]): string | undefined {
  const parts: string[] = []
  let index = messages.length - 1
  while (index >= 0 && messages[index]!.role === "user" && messages[index]!.toolResults === undefined) index--
  for (; index >= 0; index--) {
    const message = messages[index]!
    if (message.role === "user" || message.toolUses.length > 0) break
    if (message.text.trim() !== "") parts.unshift(message.text)
  }
  return parts.length === 0 ? undefined : parts.join("\n")
}

/** The picker's choices for `blocks`, newest first: `value` is the block's index. */
export function replayOptions(blocks: readonly string[]): PickerOption[] {
  const options: PickerOption[] = []
  for (let index = blocks.length - 1; index >= 0 && options.length < MAX_BLOCKS; index--) {
    options.push({ value: String(index), label: replayLabel(blocks[index]!) })
  }
  return options
}

/** A block's first sentence as it would be heard, cut to one short line. */
function replayLabel(block: string): string {
  const first = toSentences(block).find(sentence => typeof sentence === "string") ?? "（コードのみ）"
  const characters = Array.from(first)
  return characters.length > MAX_LABEL ? `${characters.slice(0, MAX_LABEL - 1).join("")}…` : first
}
