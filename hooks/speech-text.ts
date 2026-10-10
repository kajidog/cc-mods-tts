/** Sentence ends: Japanese/full-width punctuation with any closing brackets, or a period before whitespace. */
const TERMINATOR = /[。！？!?]+[」』）)"]*|\.(?=\s)/g
const SPEAKABLE = /[\p{L}\p{N}]/u
const MAX_SENTENCE = 160
const LIST_MARKER = /^\s*(?:[-*+–—•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/
const PATH_NAME = String.raw`[\p{L}\p{N}\p{M}_@+-][\p{L}\p{N}\p{M}_.@+-]*\.[A-Za-z][A-Za-z0-9]{0,9}`
const PATH_LINE = String.raw`(?:(?::|#L)(\d+)(?:-L?(\d+))?(?::\d+)?)?`
/**
 * A file path, optionally in backticks and with a line (`:12`, `:12:5`,
 * `:12-20`, `#L12-L20`). Folders need a separator and the name an extension
 * that starts with a letter, so `and/or`, `1/2` and `v1.2/v1.3` never match.
 * Folders have no spaces, so a match never runs across prose.
 */
const PATH = new RegExp(
  String.raw`(?<![\p{L}\p{N}\p{M}_.:/\\~-])(\x60?)(~|[A-Za-z]:)?((?:[\p{L}\p{N}\p{M}_.@+-]*[/\\])+)(${PATH_NAME})${PATH_LINE}(\x60?)(?![\p{L}\p{N}\p{M}_/\\])`,
  "gu",
)
/** Ends what came before, so a path may follow at once: Japanese punctuation and brackets. */
const PATH_SEPARATORS = /[\s、。，：；（［｛〈《「『【]/
/** May open a path when they start a word: ASCII brackets and quotes. */
const PATH_OPENERS = /[([{<"'\x60]/
/** A whole inline code span that is a path; only there, its folders may have spaces. */
const CODE_PATH = new RegExp(String.raw`^(~|[A-Za-z]:)?((?:[\p{L}\p{N}\p{M}_.@+ -]*[/\\])+)(${PATH_NAME})${PATH_LINE}$`, "u")

/** Where fenced code was skipped; the reader decides what, if anything, to say there. */
export const SKIPPED_CODE: unique symbol = Symbol("skipped code")

/** What a reply turns into for a listener: its sentences, and marks where code was skipped. */
export type Spoken = string | typeof SKIPPED_CODE

/**
 * Turns streamed Markdown into speakable sentences as early as possible:
 * complete sentences of the current line are released before its newline
 * arrives, and fenced code and tables are never spoken.
 */
export class SpeechSplitter {
  private partial = ""
  private fence: string | undefined

  push(text: string): Spoken[] {
    this.partial += text
    const sentences: Spoken[] = []

    let newline = this.partial.indexOf("\n")
    while (newline >= 0) {
      sentences.push(...this.line(this.partial.slice(0, newline)))
      this.partial = this.partial.slice(newline + 1)
      newline = this.partial.indexOf("\n")
    }

    // Keep unfinished links and URLs whole: punctuation inside them is not a sentence end.
    // Lines that may open a fence or a table also wait for their newline.
    if (this.fence === undefined && !/^\s*[`~|]/.test(this.partial)) {
      const markup = this.partial.search(/https?:\/\/|!?\[/)
      // The period in "1. " belongs to the list marker, not a spoken sentence.
      const start = LIST_MARKER.exec(this.partial)?.[0].length ?? 0
      const end = markup < 0 ? this.partial.length : Math.max(start, markup)
      const cut = lastTerminatorEnd(this.partial.slice(start, end))
      if (cut > 0) {
        sentences.push(...this.line(this.partial.slice(0, start + cut)))
        this.partial = this.partial.slice(start + cut)
      }
    }
    return sentences
  }

  flush(): Spoken[] {
    const sentences = this.line(this.partial)
    this.partial = ""
    this.fence = undefined
    return sentences
  }

  private line(text: string): Spoken[] {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(text)
    if (this.fence !== undefined) {
      if (marker && marker[1]!.startsWith(this.fence) && marker[2]!.trim() === "") {
        this.fence = undefined
      }
      return []
    }
    if (marker) {
      this.fence = marker[1]
      return [SKIPPED_CODE]
    }
    return splitSentences(toSpeakable(text))
  }
}

/** A whole Markdown text as speakable sentences. */
export function toSentences(text: string): Spoken[] {
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
    .replace(LIST_MARKER, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "URL")
    .replace(/`([^`]+)`/g, speakCodePath)
    .replace(PATH, speakPath)
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|~~|(?<!\w)\*(?!\s)|(?<!\s)\*(?!\w)/g, "")
    .replace(/[()[\]{}（）［］｛｝「」『』【】〈〉《》]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Reads a path as its file name and line: "speech-text.tsの12行目". */
function spokenPath(name: string, line: string | undefined, end: string | undefined): string {
  return line === undefined ? name : end === undefined ? `${name}の${line}行目` : `${name}の${line}から${end}行目`
}

/** Whether a path may start right after `before`, not in the middle of a longer one. */
function startsPath(before: string): boolean {
  const last = before.at(-1)
  if (last === undefined || PATH_SEPARATORS.test(last)) return true
  if (!PATH_OPENERS.test(last)) return false
  const prior = before.at(-2)
  return prior === undefined || !/[\x21-\x7e]/.test(prior)
}

function isRootedPath(root: string | undefined, dirs: string): boolean {
  return root !== undefined || /^\.{0,2}[/\\]/.test(dirs)
}

/**
 * Shortens a code span that is a path with spaces in its folders, when it is
 * rooted: `cat src/a.ts` or `My Project/src/a.ts` could be a command or a
 * folder, so they stay whole.
 */
function speakCodePath(span: string, inner: string): string {
  const match = CODE_PATH.exec(inner)
  if (match === null) return span
  const [, root, dirs = "", name = "", line, end] = match
  return isRootedPath(root, dirs) ? spokenPath(name, line, end) : span
}

/**
 * Shortens a path without spaces, only when it is clearly a path: rooted
 * (`/`, `~/`, `./`, `C:\\`), with a line, or a whole inline code span. A
 * bare `React/Next.js` stays. A path joined to the text before it, or an
 * unrooted one right after a word and a space, may be the tail of a longer
 * path (`/tmp/foo&bar/a.ts`, `My Project/src/a.ts`), so it stays whole.
 */
function speakPath(
  match: string,
  open: string,
  root: string | undefined,
  dirs: string,
  name: string,
  line: string | undefined,
  end: string | undefined,
  close: string,
  offset: number,
  text: string,
): string {
  const code = open !== "" && close !== ""
  const isRooted = isRootedPath(root, dirs)
  if (!(code || line !== undefined || isRooted)) return match
  if (open === "") {
    const before = text.slice(0, offset)
    // Text joined to the match (`foo&` in `/tmp/foo&bar/a.ts`) means it is the tail of a longer path.
    if (!startsPath(before)) return match
    if (!isRooted && /[\p{L}\p{N}\p{M}] $/u.test(before)) return match
  }
  const spoken = spokenPath(name, line, end)
  return code ? spoken : `${open}${spoken}${close}`
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
    .map(sentence => sentence.trim())
    .filter(sentence => SPEAKABLE.test(sentence))
}

/**
 * Engines choke on very long input: split at a comma near the limit, else hard.
 * Applied as a sentence is queued, so the response budget sees whole sentences.
 */
export function capLength(sentence: string): string[] {
  const pieces: string[] = []
  let rest = Array.from(sentence)
  while (rest.length > MAX_SENTENCE) {
    const comma = Math.max(rest.lastIndexOf("、", MAX_SENTENCE - 1), rest.lastIndexOf(",", MAX_SENTENCE - 1))
    const cut = comma > MAX_SENTENCE / 2 ? comma + 1 : MAX_SENTENCE
    pieces.push(rest.slice(0, cut).join(""))
    rest = rest.slice(cut)
  }
  pieces.push(rest.join(""))
  return pieces
}

function lastTerminatorEnd(text: string): number {
  let end = 0
  for (const match of text.matchAll(TERMINATOR)) end = match.index + match[0].length
  return end
}
