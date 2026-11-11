/**
 * Hand-rolled, zero-dependency frontmatter for memory files.
 *
 * A memory file is a strict `---`-delimited block of `key: value` scalars plus
 * arrays of strings (arrays are a `key:` line followed by indented `- item`
 * lines), then the markdown body after the closing `---`:
 *
 *   ---
 *   id: mem-abc12345
 *   title: Store monetary amounts as integer cents
 *   supersedes:
 *     - mem-old11111
 *     - mem-old22222
 *   ---
 *   Always store amounts as integer cents.
 *
 * Values that contain characters a line-based parser could misread (colons,
 * `#`, leading `-`, quotes, newlines, leading/trailing whitespace) are double
 * quoted and backslash-escaped so a serialize → parse round-trip is lossless.
 */

export type FrontmatterValue = string | string[]
export type Frontmatter = Record<string, FrontmatterValue>

/**
 * Parse frontmatter from a full file's text. Returns `null` when the text has
 * no opening `---` or no closing `---` (malformed — the caller treats the file
 * as invalid). Unknown `key: value` lines are preserved as scalars.
 */
export function parseFrontmatter(text: string): { frontmatter: Frontmatter; body: string } | null {
  const lines = text.split("\n")
  if ((lines[0] ?? "").trim() !== "---") return null

  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      end = i
      break
    }
  }
  if (end === -1) return null

  const fmLines = lines.slice(1, end)
  const body = lines.slice(end + 1).join("\n").trim()

  const frontmatter: Frontmatter = {}
  let i = 0
  while (i < fmLines.length) {
    const line = fmLines[i]!
    if (line.trim() === "") {
      i++
      continue
    }
    const m = line.match(/^([A-Za-z0-9_-]+):(.*)$/)
    if (!m) {
      i++
      continue
    }
    const key = m[1]!
    const rest = m[2]!
    if (rest.trim() === "") {
      // Empty value: either an empty scalar or an array of following `- item` lines.
      const items: string[] = []
      let k = i + 1
      while (k < fmLines.length && /^\s+-\s?/.test(fmLines[k]!)) {
        items.push(parseScalar(fmLines[k]!.replace(/^\s+-\s?/, "")))
        k++
      }
      if (items.length > 0) {
        frontmatter[key] = items
        i = k
      } else {
        frontmatter[key] = ""
        i++
      }
      continue
    }
    frontmatter[key] = parseScalar(rest.trim())
    i++
  }

  return { frontmatter, body }
}

/**
 * Serialize frontmatter and body back to a full file's text. Known fields are
 * emitted in a canonical order (kept in FIELD_ORDER); any other keys present in
 * the record are appended so round-trips preserve them.
 */
export function serializeFrontmatter(frontmatter: Frontmatter, body: string): string {
  const lines: string[] = ["---"]
  for (const key of FIELD_ORDER) {
    append(lines, key, frontmatter[key])
  }
  for (const key of Object.keys(frontmatter)) {
    if ((FIELD_ORDER as readonly string[]).includes(key)) continue
    append(lines, key, frontmatter[key])
  }
  lines.push("---")
  if (body) lines.push(body)
  return lines.join("\n") + "\n"
}

const FIELD_ORDER = [
  "id",
  "title",
  "tags",
  "author",
  "source",
  "proposed_at",
  "approved_at",
  "approved_by",
  "supersedes",
  "superseded_by",
  "retired_at",
  "retired_reason",
  "related_pr",
  "intent",
] as const

function append(lines: string[], key: string, value: FrontmatterValue | undefined): void {
  if (value === undefined) return
  if (Array.isArray(value)) {
    if (value.length === 0) return
    lines.push(`${key}:`)
    for (const item of value) lines.push(`  - ${serializeScalar(item)}`)
    return
  }
  lines.push(`${key}: ${serializeScalar(value)}`)
}

function serializeScalar(value: string): string {
  if (value.includes("\n")) {
    return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"'
  }
  if (needsQuote(value)) {
    return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
  }
  return value
}

function needsQuote(value: string): boolean {
  if (value === "") return true
  if (/^\s|\s$/.test(value)) return true
  if (/^[-#?!|>@`"'{}[\]&*,%]/.test(value)) return true
  if (/:\s/.test(value) || value.endsWith(":")) return true
  if (/\s#/.test(value)) return true
  return false
}

function parseScalar(raw: string): string {
  const s = raw.trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return decodeQuoted(s.slice(1, -1))
  }
  return s
}

function decodeQuoted(s: string): string {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (ch !== "\\") {
      out += ch
      continue
    }
    const next = s[i + 1]
    if (next === undefined) {
      out += "\\"
      continue
    }
    if (next === "n") out += "\n"
    else if (next === "t") out += "\t"
    else if (next === '"') out += '"'
    else if (next === "\\") out += "\\"
    else out += next
    i++
  }
  return out
}
