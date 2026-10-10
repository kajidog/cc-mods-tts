/** Sentence ends: Japanese/full-width punctuation with any closing brackets, or a period before whitespace. */
const TERMINATOR = /[。！？!?]+[」』）)"]*|\.(?=\s)/g
const SPEAKABLE = /[\p{L}\p{N}]/u
const MAX_SENTENCE = 160

/**
 * Turns streamed Markdown into speakable sentences as early as possible:
 * complete sentences of the current line are released before its newline
 * arrives, and fenced code and tables are never spoken.
 */
export class SpeechSplitter {
  private partial = ""
  private isInFence = false

  push(text: string): string[] {
    this.partial += text
    const sentences: string[] = []

    let newline = this.partial.indexOf("\n")
    while (newline >= 0) {
      sentences.push(...this.line(this.partial.slice(0, newline)))
      this.partial = this.partial.slice(newline + 1)
      newline = this.partial.indexOf("\n")
    }

    // A line that may open a fence or a table waits for its newline.
    if (!this.isInFence && !/^\s*[`|]/.test(this.partial)) {
      const cut = lastTerminatorEnd(this.partial)
      if (cut > 0) {
        sentences.push(...this.line(this.partial.slice(0, cut)))
        this.partial = this.partial.slice(cut)
      }
    }
    return sentences
  }

  flush(): string[] {
    const sentences = this.line(this.partial)
    this.partial = ""
    this.isInFence = false
    return sentences
  }

  private line(text: string): string[] {
    if (/^\s*(```|~~~)/.test(text)) {
      this.isInFence = !this.isInFence
      return []
    }
    if (this.isInFence) return []
    return splitSentences(toSpeakable(text))
  }
}

/** A whole Markdown text as speakable sentences. */
export function toSentences(text: string): string[] {
  const splitter = new SpeechSplitter()
  return [...splitter.push(text), ...splitter.flush()]
}

/** Strips the Markdown a listener should not hear from one line. */
export function toSpeakable(line: string): string {
  const text = line.trim()
  if (text.startsWith("|") || /^[-*_]{3,}$/.test(text)) return ""
  return text
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "URL")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|~~|(?<!\w)\*(?!\s)|(?<!\s)\*(?!\w)/g, "")
    .trim()
}

function splitSentences(text: string): string[] {
  const sentences: string[] = []
  let start = 0
  for (const match of text.matchAll(TERMINATOR)) {
    const end = match.index + match[0].length
    sentences.push(text.slice(start, end))
    start = end
  }
  sentences.push(text.slice(start))
  return sentences
    .flatMap(capLength)
    .map(sentence => sentence.trim())
    .filter(sentence => SPEAKABLE.test(sentence))
}

/** Engines choke on very long input: split at a comma near the limit, else hard. */
function capLength(sentence: string): string[] {
  const pieces: string[] = []
  let rest = sentence
  while (rest.length > MAX_SENTENCE) {
    const comma = Math.max(rest.lastIndexOf("、", MAX_SENTENCE), rest.lastIndexOf(", ", MAX_SENTENCE))
    const cut = comma > MAX_SENTENCE / 2 ? comma + 1 : MAX_SENTENCE
    pieces.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  pieces.push(rest)
  return pieces
}

function lastTerminatorEnd(text: string): number {
  let end = 0
  for (const match of text.matchAll(TERMINATOR)) end = match.index + match[0].length
  return end
}
