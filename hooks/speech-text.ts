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
/** Where a table was skipped, once per table. */
export const SKIPPED_TABLE: unique symbol = Symbol("skipped table")
/** Where a block quote starts, just before its first sentence or notice. */
export const QUOTED: unique symbol = Symbol("quoted")
/** Where a quote marked with `QUOTED` ends. */
export const QUOTE_ENDED: unique symbol = Symbol("quote ended")

/** What a reply turns into for a listener: its sentences, and marks where code or a table was skipped or a quote starts or ends. */
export type Spoken = string | typeof SKIPPED_CODE | typeof SKIPPED_TABLE | typeof QUOTED | typeof QUOTE_ENDED

/** A Markdown code span: as many backticks close it as open it. */
const CODE_SPAN = String.raw`(?<!\x60)(?<ticks>\x60+)(?!\x60)[\s\S]*?(?<!\x60)\k<ticks>(?!\x60)`

/**
 * HTML comments and the tags answers use, outside code spans: the tags go,
 * their text stays, and `<br>` parts words. `a < b`, `Promise<void>` stay.
 */
const TAG = String.raw`<\/?(br|kbd|details|summary|sup|sub|b|i|u|s|em|strong|mark|small|span|div|p|a|img|code|pre|ul|ol|li|hr|center)\b`
const HTML = new RegExp(
  // Quoted attribute values may hold `>`: <a title="1 > 0">.
  String.raw`(${CODE_SPAN})|<!--.*?-->|${TAG}(?:"[^"]*"|'[^']*'|[^<>"'])*>`,
  "gi",
)
/** A UUID, read as its first 8 characters. */
const UUID = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi
/** A long hex string with digits and letters (a hash), read as its first 7 characters; words like `deadbeef` stay. */
const HASH = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/gi
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/
const QUOTE_MARKER = /^[ \t]*>[ \t]?/
/** A line that starts a block of its own, so it never lazily continues a quote's paragraph. */
const BLOCK_START = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|`{3,}|~{3,}|\||[-*_]{3,}\s*$)/

/** Takes up to `levels` quote markers off the start of a line. */
function unquote(text: string, levels = Number.POSITIVE_INFINITY): { depth: number; body: string } {
  let depth = 0
  let body = text
  for (let marker = QUOTE_MARKER.exec(body); marker !== null && depth < levels; marker = QUOTE_MARKER.exec(body)) {
    body = body.slice(marker[0].length)
    depth++
  }
  return { depth, body }
}

/**
 * Where an HTML comment or tag opens in `text`, outside code spans, or a comment may yet
 * open at its end (`<!`); -1 for none. Punctuation in either ends no sentence.
 */
function markupStart(text: string): number {
  for (const match of text.matchAll(new RegExp(String.raw`${CODE_SPAN}|<!--|<!?-?$|${TAG}`, "gi"))) if (!match[0].startsWith("`")) return match.index
  return -1
}

/** Where an HTML comment opens in `text` and does not close, outside code spans; -1 for none. */
function unclosedComment(text: string): number {
  let open = -1
  for (const match of text.matchAll(new RegExp(String.raw`${CODE_SPAN}|<!--|-->`, "g"))) {
    if (match[0] === "<!--" && open < 0) open = match.index
    else if (match[0] === "-->") open = -1
  }
  return open
}

/**
 * Turns streamed Markdown into speakable sentences as early as possible:
 * complete sentences of the current line are released before its newline
 * arrives, and fenced code and tables are never spoken, in a quote or not.
 */
export class SpeechSplitter {
  private partial = ""
  private fence: string | undefined
  /** How deep in quotes the open fence is; only a line as deep may close it. */
  private fenceDepth = 0
  /** How deep in quotes the table being skipped is; undefined out of a table. */
  private tableDepth: number | undefined
  private isInQuote = false
  /** Whether an HTML comment is open; it may span sentences and lines. */
  private isInComment = false
  private isQuoteAnnounced = false
  /** Whether the last line was a quote's paragraph, which a line without `>` may continue. */
  private isQuoteParagraph = false
  /** Whether `partial` is the rest of a line whose start was already released. */
  private isContinued = false

  push(text: string): Spoken[] {
    this.partial += text
    const sentences: Spoken[] = []

    let newline = this.partial.indexOf("\n")
    while (newline >= 0) {
      sentences.push(...this.line(this.partial.slice(0, newline), true))
      this.partial = this.partial.slice(newline + 1)
      newline = this.partial.indexOf("\n")
    }

    // Keep unfinished links and URLs whole: punctuation inside them is not a sentence end.
    // Lines that may open a fence or a table, in a quote or not, also wait for their newline.
    // HTML comments and tags wait for their line: the `!` of `<!--` and sentences in them end nothing.
    if (this.fence === undefined && !this.isInComment && !/^[\s>]*[`~|]/.test(this.partial)) {
      const holds = [this.partial.search(/https?:\/\/|!?\[/), markupStart(this.partial)].filter(at => at >= 0)
      const markup = holds.length === 0 ? -1 : Math.min(...holds)
      // The period in "1. " belongs to the list marker, not a spoken sentence.
      const quote = this.isContinued ? 0 : this.partial.length - unquote(this.partial).body.length
      const start = quote + (LIST_MARKER.exec(this.partial.slice(quote))?.[0].length ?? 0)
      const end = markup < 0 ? this.partial.length : Math.max(start, markup)
      const cut = lastTerminatorEnd(this.partial.slice(start, end))
      if (cut > 0) {
        sentences.push(...this.line(this.partial.slice(0, start + cut), false))
        this.partial = this.partial.slice(start + cut)
      }
    }
    return sentences
  }

  flush(): Spoken[] {
    const sentences = this.line(this.partial, true)
    this.partial = ""
    this.fence = undefined
    this.tableDepth = undefined
    this.isInQuote = false
    this.isQuoteParagraph = false
    this.isInComment = false
    return sentences
  }

  private line(text: string, isLineEnd: boolean): Spoken[] {
    const isContinued = this.isContinued
    this.isContinued = !isLineEnd
    // The line's start may have said nothing yet ("> 🎉！"), so its quote is still to be marked.
    if (isContinued) return this.announce(this.prose(text))
    if (this.isInComment) {
      if (!text.includes("-->")) return []
      // Past the comment, the line is in its own quote, or none.
      return [...this.enterQuote(unquote(text).depth), ...this.announce(this.prose(text))]
    }

    const { depth, body } = unquote(text)
    if (this.fence !== undefined) {
      if (depth >= this.fenceDepth) {
        const marker = FENCE.exec(unquote(text, this.fenceDepth).body)
        if (marker && marker[1]!.startsWith(this.fence) && marker[2]!.trim() === "") this.fence = undefined
        return []
      }
      // A quote that ends closes the code fenced in it.
      this.fence = undefined
    }

    // A line without `>` right after a quote's paragraph lazily continues it.
    const isLazy = depth === 0 && this.isQuoteParagraph && text.trim() !== "" && !BLOCK_START.test(text)
    const ended = isLazy ? [] : this.enterQuote(depth)
    this.isQuoteParagraph = false
    let spoken: Spoken[]
    const marker = FENCE.exec(body)
    if (marker) {
      this.fence = marker[1]
      this.fenceDepth = depth
      this.tableDepth = undefined
      spoken = [SKIPPED_CODE]
    } else if (body.trim().startsWith("|")) {
      // A table in or out of a quote right after another is a table of its own.
      spoken = this.tableDepth === depth ? [] : [SKIPPED_TABLE]
      this.tableDepth = depth
      // The row is not said, but a comment it opens hides the lines after it.
      this.prose(body)
    } else {
      this.tableDepth = undefined
      spoken = this.prose(body)
      this.isQuoteParagraph = this.isInQuote && body.trim() !== ""
    }

    return [...ended, ...this.announce(spoken)]
  }

  /** Moves to a line `depth` quotes deep; marks the end of a quote that was marked. */
  private enterQuote(depth: number): Spoken[] {
    if (depth === 0) {
      const wasAnnounced = this.isInQuote && this.isQuoteAnnounced
      this.isQuoteParagraph = false
      this.isInQuote = false
      return wasAnnounced ? [QUOTE_ENDED] : []
    }
    if (!this.isInQuote) {
      this.isInQuote = true
      this.isQuoteAnnounced = false
    }
    return []
  }

  /** Marks where a quote starts, before the first it says. */
  private announce(spoken: Spoken[]): Spoken[] {
    if (!this.isInQuote || this.isQuoteAnnounced || spoken.length === 0) return spoken
    this.isQuoteAnnounced = true
    return [QUOTED, ...spoken]
  }

  /** The sentences of a line's text, without HTML comments, which may span lines. */
  private prose(text: string): string[] {
    let rest = text
    if (this.isInComment) {
      const close = rest.indexOf("-->")
      if (close < 0) return []
      this.isInComment = false
      rest = rest.slice(close + "-->".length)
    }
    const open = unclosedComment(rest)
    if (open >= 0) {
      this.isInComment = true
      rest = rest.slice(0, open)
    }
    return splitSentences(toSpeakable(rest))
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
    .replace(HTML, (match, code: string | undefined, _ticks: string | undefined, tag: string | undefined) =>
      code ?? (tag?.toLowerCase() === "br" ? " " : ""),
    )
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "URL")
    .replace(/`([^`]+)`/g, speakCodePath)
    .replace(PATH, speakPath)
    .replace(/`([^`]*)`/g, "$1")
    .replace(UUID, uuid => uuid.slice(0, 8))
    .replace(HASH, hash => hash.slice(0, 7))
    // Identifiers read as words: SKIPPED_CODE, maxCharsPerTurn. A capital after one lowercase
    // letter (iPhone, dB) or after capitals (URLs, SQLite, WSLg) is part of a name, not a word break.
    .replace(/_+/g, " ")
    .replace(/(?<=[a-z]{2})(?=[A-Z])/g, " ")
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
