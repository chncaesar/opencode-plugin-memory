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
export type FrontmatterValue = string | string[];
export type Frontmatter = Record<string, FrontmatterValue>;
/**
 * Parse frontmatter from a full file's text. Returns `null` when the text has
 * no opening `---` or no closing `---` (malformed — the caller treats the file
 * as invalid). Unknown `key: value` lines are preserved as scalars.
 */
export declare function parseFrontmatter(text: string): {
    frontmatter: Frontmatter;
    body: string;
} | null;
/**
 * Serialize frontmatter and body back to a full file's text. Known fields are
 * emitted in a canonical order (kept in FIELD_ORDER); any other keys present in
 * the record are appended so round-trips preserve them.
 */
export declare function serializeFrontmatter(frontmatter: Frontmatter, body: string): string;
//# sourceMappingURL=frontmatter.d.ts.map