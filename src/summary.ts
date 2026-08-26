import fs from "fs/promises"
import path from "path"
import type { MemoryStore } from "./types.js"
import { summaryFilePath, memoryDir } from "./storage.js"

const SUMMARY_HEADER = `<!-- opencode-plugin-memory: project memory summary -->
<!-- This file is auto-generated — edit MEMORY.md instead -->`

/**
 * Build the text content for memory_summary.md from active entries,
 * truncated to at most maxChars characters.
 *
 * The summary is intentionally compact so it can be injected into every
 * system prompt with minimal token cost.  Entries are ordered newest-first
 * (by "added" date) so the most recent knowledge survives truncation.
 */
export function buildSummary(store: MemoryStore, maxChars: number): string {
  const active = store.entries
    .filter((e) => !e.archived)
    .sort((a, b) => (b.added > a.added ? 1 : b.added < a.added ? -1 : 0))

  if (active.length === 0) {
    return [SUMMARY_HEADER, "", "No memories stored yet.", ""].join("\n")
  }

  const lines: string[] = [
    SUMMARY_HEADER,
    "",
    "Project memories (use memory_read for full content, memory_add/update/delete to manage):",
    "",
  ]

  for (const e of active) {
    const tags = e.tags && e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : ""
    const line = `- [${e.id}]${tags} ${e.title}`
    lines.push(line)
  }

  lines.push("")
  const full = lines.join("\n")

  if (full.length <= maxChars) return full

  // Truncate: keep header + as many entries as fit, with a truncation notice
  const header = [
    SUMMARY_HEADER,
    "",
    "Project memories (truncated — use memory_read for full list):",
    "",
  ].join("\n")

  const notice = `\n... (${active.length} total; showing recent entries only)\n`
  const budget = maxChars - header.length - notice.length - 2

  const entryLines = lines.slice(4, -1) // just the "- [MEM-xxx] ..." lines
  let kept = ""
  for (const line of entryLines) {
    if (kept.length + line.length + 1 > budget) break
    kept += line + "\n"
  }

  return header + kept + notice
}

/**
 * Write the summary file to disk, creating the directory if needed.
 */
export async function writeSummary(projectDir: string, store: MemoryStore, maxChars: number): Promise<void> {
  const dir = memoryDir(projectDir)
  await fs.mkdir(dir, { recursive: true })
  const content = buildSummary(store, maxChars)
  await fs.writeFile(summaryFilePath(projectDir), content, "utf8")
}

/**
 * Read the current summary file, returning an empty string if it does not exist.
 */
export async function readSummary(projectDir: string): Promise<string> {
  try {
    return await fs.readFile(summaryFilePath(projectDir), "utf8")
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") return ""
    throw err
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err
}
