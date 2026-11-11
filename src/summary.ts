import fs from "fs/promises"
import { listActiveMemories, memoryRootDir, summaryFilePath } from "./storage.js"
import type { Memory } from "./types.js"
import { MEMORY_WRITE_POLICY } from "./prompt.js"

const SUMMARY_HEADER = [
  "<!-- opencode-plugin-memory: project memory index -->",
  "<!-- auto-generated — edit memory files, not this index -->",
].join("\n")

const MEMORY_SYSTEM_INTRO = [
  "<!-- opencode-plugin-memory: PR-gated project memory system -->",
  "",
  "You have a PR-gated, project-scoped memory system (tools: memory_propose, memory_update, memory_delete, memory_read, memory_review).",
  "You only PROPOSE memories; a human approves each one by merging a pull request before it becomes active.",
].join("\n")

/**
 * Build the committed index: one line per active memory, `[mem-XXXX] Title`,
 * ordered deterministically (by id) so regeneration is stable across runs.
 */
export function buildSummaryContent(memories: Memory[]): string {
  const sorted = [...memories].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (sorted.length === 0) {
    return `${SUMMARY_HEADER}\n\n<!-- no active memories -->\n`
  }
  return `${SUMMARY_HEADER}\n\n${sorted.map((m) => `[${m.id}] ${m.title}`).join("\n")}\n`
}

/**
 * Regenerate `memory/_summary.md` from the active memories. Called by migration
 * and later by CI on merge. Never called when proposing (proposals must stay
 * invisible until merged).
 */
export async function generateSummary(projectDir: string): Promise<void> {
  const memories = await listActiveMemories(projectDir)
  await fs.mkdir(memoryRootDir(projectDir), { recursive: true })
  await fs.writeFile(summaryFilePath(projectDir), buildSummaryContent(memories), "utf8")
}

/**
 * Read the committed index; empty string when it does not exist.
 */
export async function readSummaryContent(projectDir: string): Promise<string> {
  try {
    return await fs.readFile(summaryFilePath(projectDir), "utf8")
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") return ""
    throw err
  }
}

const INDEX_LINE_RE = /^\[mem-[A-Za-z0-9_-]{8}\]/

/** Extract just the `[mem-XXXX] Title` lines from raw summary content. */
export function extractIndexLines(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => INDEX_LINE_RE.test(l))
}

/**
 * Build the block injected into every system prompt: the memory-system
 * introduction, the committed index (titles and ids only, never full bodies),
 * and the complete writing policy. `summaryContent` is the raw `_summary.md`.
 */
export function buildSystemPrompt(summaryContent: string, maxChars: number): string {
  const lines = extractIndexLines(summaryContent)
  let index: string

  if (lines.length === 0) {
    index = "(no active memories — propose your first with memory_propose)"
  } else {
    let body = lines.join("\n")
    if (body.length > maxChars) {
      const notice = `\n… (${lines.length} active memories; showing a subset — use memory_read for the full list)`
      const kept: string[] = []
      let budget = maxChars - notice.length
      for (const line of lines) {
        const cost = line.length + (kept.length > 0 ? 1 : 0)
        if (cost > budget) break
        kept.push(line)
        budget -= cost
      }
      body = kept.join("\n") + notice
    }
    index = body
  }

  return [MEMORY_SYSTEM_INTRO, "", "Project memory index:", index, MEMORY_WRITE_POLICY, ""].join("\n\n")
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err
}
