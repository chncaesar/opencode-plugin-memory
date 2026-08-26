import fs from "fs/promises"
import path from "path"
import type { MemoryEntry, MemoryStore } from "./types.js"

// File names inside the project memory directory
const MEMORY_DIR = ".opencode/memory"
const MEMORY_FILE = "MEMORY.md"
const SUMMARY_FILE = "memory_summary.md"

// Section headings in MEMORY.md
const ACTIVE_HEADING = "## Active"
const ARCHIVED_HEADING = "## Archived"

// Entry block separator: ### [MEM-NNN] Title
const ENTRY_HEADING_RE = /^### \[(MEM-\d+)\] (.+)$/

/**
 * Resolve the .opencode/memory directory for a given project root.
 */
export function memoryDir(projectDir: string): string {
  return path.join(projectDir, MEMORY_DIR)
}

export function memoryFilePath(projectDir: string): string {
  return path.join(memoryDir(projectDir), MEMORY_FILE)
}

export function summaryFilePath(projectDir: string): string {
  return path.join(memoryDir(projectDir), SUMMARY_FILE)
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse the raw MEMORY.md text into a MemoryStore.
 * Format contract:
 *
 *   # OpenCode Memory
 *   <!-- nextSeq: 3 -->
 *
 *   ## Active
 *
 *   ### [MEM-001] Title here
 *   - added: 2026-08-26
 *   - updated: 2026-08-27
 *   - tags: coding-style, workflow
 *   Body content (may span multiple lines).
 *
 *   ## Archived
 *
 *   ### [MEM-002] Old title
 *   - added: 2026-08-20
 *   - archived: true
 *   Old content.
 */
export function parseMemory(text: string): MemoryStore {
  const lines = text.split("\n")
  const entries: MemoryEntry[] = []
  let nextSeq = 1

  // Extract nextSeq from metadata comment
  for (const line of lines) {
    const m = line.match(/<!--\s*nextSeq:\s*(\d+)\s*-->/)
    if (m) {
      nextSeq = parseInt(m[1] ?? "1", 10)
      break
    }
  }

  let inArchived = false
  let currentEntry: Partial<MemoryEntry> | null = null
  let bodyLines: string[] = []

  const flushEntry = () => {
    if (!currentEntry?.id || !currentEntry.title) return
    const entry: MemoryEntry = {
      id: currentEntry.id,
      title: currentEntry.title,
      content: bodyLines.join("\n").trim(),
      added: currentEntry.added ?? today(),
      archived: inArchived,
    }
    if (currentEntry.updated !== undefined) entry.updated = currentEntry.updated
    if (currentEntry.tags !== undefined) entry.tags = currentEntry.tags
    entries.push(entry)
    currentEntry = null
    bodyLines = []
  }

  for (const line of lines) {
    if (line.startsWith("## Active")) {
      flushEntry()       // flush before changing section
      inArchived = false
      continue
    }
    if (line.startsWith("## Archived")) {
      flushEntry()       // flush before changing section
      inArchived = true
      continue
    }

    const headingMatch = line.match(ENTRY_HEADING_RE)
    if (headingMatch) {
      flushEntry()
      const id = headingMatch[1]
      const title = headingMatch[2]
      if (id && title) {
        currentEntry = { id, title }
      }
      bodyLines = []
      continue
    }

    if (currentEntry) {
      // Parse metadata lines like "- added: 2026-08-26"
      const metaAdded = line.match(/^- added:\s*(.+)$/)
      const metaUpdated = line.match(/^- updated:\s*(.+)$/)
      const metaTags = line.match(/^- tags:\s*(.+)$/)
      const metaArchived = line.match(/^- archived:\s*true/)

      if (metaAdded) {
        const val = metaAdded[1]?.trim()
        if (val) currentEntry.added = val
        continue
      }
      if (metaUpdated) {
        const val = metaUpdated[1]?.trim()
        if (val) currentEntry.updated = val
        continue
      }
      if (metaTags) {
        const val = metaTags[1]
        if (val) currentEntry.tags = val.split(",").map((t) => t.trim()).filter(Boolean)
        continue
      }
      if (metaArchived) {
        // Handled by section heading; ignore inline flag
        continue
      }
      bodyLines.push(line)
    }
  }
  flushEntry()

  return { entries, nextSeq }
}

// ─── Serialiser ──────────────────────────────────────────────────────────────

/**
 * Serialize a MemoryStore back into MEMORY.md text.
 */
export function serializeMemory(store: MemoryStore): string {
  const active = store.entries.filter((e) => !e.archived)
  const archived = store.entries.filter((e) => e.archived)

  const lines: string[] = [
    "# OpenCode Memory",
    `<!-- nextSeq: ${store.nextSeq} -->`,
    "<!-- auto-managed by opencode-plugin-memory — do not edit section headings -->",
    "",
    "## Active",
    "",
  ]

  for (const e of active) {
    lines.push(...serializeEntry(e))
  }

  lines.push("## Archived", "")

  for (const e of archived) {
    lines.push(...serializeEntry(e))
  }

  return lines.join("\n")
}

function serializeEntry(e: MemoryEntry): string[] {
  const lines: string[] = [`### [${e.id}] ${e.title}`, `- added: ${e.added}`]
  if (e.updated) lines.push(`- updated: ${e.updated}`)
  if (e.tags && e.tags.length > 0) lines.push(`- tags: ${e.tags.join(", ")}`)
  lines.push(e.content, "")
  return lines
}

// ─── I/O helpers ─────────────────────────────────────────────────────────────

/**
 * Read and parse MEMORY.md, returning an empty store if the file does not exist.
 */
export async function readStore(projectDir: string): Promise<MemoryStore> {
  const filePath = memoryFilePath(projectDir)
  try {
    const text = await fs.readFile(filePath, "utf8")
    return parseMemory(text)
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return { entries: [], nextSeq: 1 }
    }
    throw err
  }
}

/**
 * Write the store back to MEMORY.md, creating the directory if needed.
 */
export async function writeStore(projectDir: string, store: MemoryStore): Promise<void> {
  const dir = memoryDir(projectDir)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(memoryFilePath(projectDir), serializeMemory(store), "utf8")
}

// ─── CRUD operations ─────────────────────────────────────────────────────────

/**
 * Add a new entry and return the assigned ID.
 */
export function addEntry(
  store: MemoryStore,
  title: string,
  content: string,
  tags?: string[],
): { store: MemoryStore; id: string } {
  const id = `MEM-${String(store.nextSeq).padStart(3, "0")}`
  const entry: MemoryEntry = {
    id,
    title,
    content,
    added: today(),
    archived: false,
  }
  if (tags !== undefined && tags.length > 0) entry.tags = tags
  return {
    store: {
      entries: [...store.entries, entry],
      nextSeq: store.nextSeq + 1,
    },
    id,
  }
}

/**
 * Update an existing entry by ID.  Returns null if not found.
 */
export function updateEntry(
  store: MemoryStore,
  id: string,
  patch: { title?: string; content?: string; tags?: string[] },
): MemoryStore | null {
  const idx = store.entries.findIndex((e) => e.id === id && !e.archived)
  if (idx === -1) return null

  const existing = store.entries[idx]
  if (!existing) return null

  const updated: MemoryEntry = {
    id: existing.id,
    title: patch.title !== undefined ? patch.title : existing.title,
    content: patch.content !== undefined ? patch.content : existing.content,
    added: existing.added,
    updated: today(),
    archived: existing.archived,
  }
  if (patch.tags !== undefined) {
    updated.tags = patch.tags
  } else if (existing.tags !== undefined) {
    updated.tags = existing.tags
  }

  const entries = [...store.entries]
  entries[idx] = updated
  return { ...store, entries }
}

/**
 * Soft-delete an entry by ID (moves it to the Archived section).
 * Returns null if not found.
 */
export function archiveEntry(store: MemoryStore, id: string): MemoryStore | null {
  const idx = store.entries.findIndex((e) => e.id === id && !e.archived)
  if (idx === -1) return null

  const existing = store.entries[idx]
  if (!existing) return null

  const archived: MemoryEntry = {
    id: existing.id,
    title: existing.title,
    content: existing.content,
    added: existing.added,
    updated: today(),
    archived: true,
  }
  if (existing.tags !== undefined) archived.tags = existing.tags

  const entries = [...store.entries]
  entries[idx] = archived
  return { ...store, entries }
}

/**
 * Search active entries by keyword (case-insensitive match on title + content + tags).
 */
export function searchEntries(store: MemoryStore, query: string): MemoryEntry[] {
  const q = query.toLowerCase()
  return store.entries.filter(
    (e) =>
      !e.archived &&
      (e.title.toLowerCase().includes(q) ||
        e.content.toLowerCase().includes(q) ||
        (e.tags ?? []).some((t) => t.toLowerCase().includes(q))),
  )
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err
}
