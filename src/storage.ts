import fs from "fs/promises"
import path from "path"
import crypto from "crypto"
import { execFile } from "child_process"
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "./frontmatter.js"
import { INTENTS, RETIRED_REASONS, type Intent, type Memory, type MemoryStatus, type RetiredReason } from "./types.js"

// ─── Paths ──────────────────────────────────────────────────────────────────
//
// State is positional: the folder a file lives in is its status.
//   .memory/staging/     machine-local, git-ignored; the agent writes proposals here
//   memory/active/       merged truth; the only memories injected into context
//   memory/retired/      removed memories, with reason and provenance
//   memory/_summary.md   committed index, one line per active memory

const MACHINE_DIR = ".memory"
const STAGING_DIR = ".memory/staging"
const MEMORY_ROOT = "memory"
const ACTIVE_DIR = "memory/active"
const RETIRED_DIR = "memory/retired"
const SUMMARY_FILE = "_summary.md"
const MIGRATION_FILE = ".migration.json"

/** Machine-local `.memory` directory (staging + plugin.log). */
export function machineDir(projectDir: string): string {
  return path.join(projectDir, MACHINE_DIR)
}

/** The git-ignored folder the agent writes proposals into. */
export function stagingDir(projectDir: string): string {
  return path.join(projectDir, STAGING_DIR)
}

/** The committed memory root (`memory/`), holding active/, retired/, _summary.md. */
export function memoryRootDir(projectDir: string): string {
  return path.join(projectDir, MEMORY_ROOT)
}

/** The committed active-memory directory. */
export function activeDir(projectDir: string): string {
  return path.join(projectDir, ACTIVE_DIR)
}

/** The committed retired-memory directory. */
export function retiredDir(projectDir: string): string {
  return path.join(projectDir, RETIRED_DIR)
}

/** The committed index file, a sibling of `memory/active/`. */
export function summaryFilePath(projectDir: string): string {
  return path.join(projectDir, MEMORY_ROOT, SUMMARY_FILE)
}

/** The old-ID → new-ID mapping written by migration. */
export function migrationFilePath(projectDir: string): string {
  return path.join(projectDir, MEMORY_ROOT, MIGRATION_FILE)
}

// ─── Identity ───────────────────────────────────────────────────────────────

const ID_RE = /^mem-[A-Za-z0-9_-]{8}$/

/** True when `value` is a well-formed memory id (`mem-` + 8 base64url chars). */
export function isMemoryId(value: string): boolean {
  return ID_RE.test(value)
}

/**
 * Generate a collision-free random id: `mem-` + 8 chars from
 * `crypto.randomBytes(6).toString("base64url")`. No sequential counter.
 */
export function generateMemoryId(): string {
  return "mem-" + crypto.randomBytes(6).toString("base64url")
}

// ─── Frontmatter ↔ Memory mapping ───────────────────────────────────────────

function memoryToFrontmatter(memory: Memory): Frontmatter {
  const fm: Frontmatter = { id: memory.id, title: memory.title }
  if (memory.tags !== undefined) fm["tags"] = memory.tags
  if (memory.author !== undefined) fm["author"] = memory.author
  if (memory.source !== undefined) fm["source"] = memory.source
  if (memory.proposedAt !== undefined) fm["proposed_at"] = memory.proposedAt
  if (memory.approvedAt !== undefined) fm["approved_at"] = memory.approvedAt
  if (memory.approvedBy !== undefined) fm["approved_by"] = memory.approvedBy
  if (memory.supersedes !== undefined) fm["supersedes"] = memory.supersedes
  if (memory.supersededBy !== undefined) fm["superseded_by"] = memory.supersededBy
  if (memory.retiredAt !== undefined) fm["retired_at"] = memory.retiredAt
  if (memory.retiredReason !== undefined) fm["retired_reason"] = memory.retiredReason
  if (memory.relatedPr !== undefined) fm["related_pr"] = memory.relatedPr
  if (memory.intent !== undefined) fm["intent"] = memory.intent
  return fm
}

function scalar(fm: Frontmatter, key: string): string | undefined {
  const v = fm[key]
  return typeof v === "string" ? v : undefined
}

function stringArray(fm: Frontmatter, key: string): string[] | undefined {
  const v = fm[key]
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined
}

function frontmatterToMemory(fm: Frontmatter): Memory | null {
  const id = fm["id"]
  const title = fm["title"]
  if (typeof id !== "string" || !isMemoryId(id)) return null
  if (typeof title !== "string") return null

  const memory: Memory = { id, title, body: "" }

  const tags = stringArray(fm, "tags")
  const author = scalar(fm, "author")
  const source = scalar(fm, "source")
  const proposedAt = scalar(fm, "proposed_at")
  const approvedAt = scalar(fm, "approved_at")
  const approvedBy = scalar(fm, "approved_by")
  const supersedes = stringArray(fm, "supersedes")
  const supersededBy = scalar(fm, "superseded_by")
  const retiredAt = scalar(fm, "retired_at")
  const retiredReasonRaw = scalar(fm, "retired_reason")
  const relatedPr = scalar(fm, "related_pr")
  const intentRaw = scalar(fm, "intent")

  if (tags !== undefined) memory.tags = tags
  if (author !== undefined) memory.author = author
  if (source !== undefined) memory.source = source
  if (proposedAt !== undefined) memory.proposedAt = proposedAt
  if (approvedAt !== undefined) memory.approvedAt = approvedAt
  if (approvedBy !== undefined) memory.approvedBy = approvedBy
  if (supersedes !== undefined) memory.supersedes = supersedes
  if (supersededBy !== undefined) memory.supersededBy = supersededBy
  if (retiredAt !== undefined) memory.retiredAt = retiredAt
  if (retiredReasonRaw !== undefined && (RETIRED_REASONS as readonly string[]).includes(retiredReasonRaw)) {
    memory.retiredReason = retiredReasonRaw as RetiredReason
  }
  if (relatedPr !== undefined) memory.relatedPr = relatedPr
  if (intentRaw !== undefined && (INTENTS as readonly string[]).includes(intentRaw)) {
    memory.intent = intentRaw as Intent
  }
  return memory
}

// ─── Read ───────────────────────────────────────────────────────────────────

/** Serialize a memory into the full on-disk file text. */
export function serializeMemory(memory: Memory): string {
  return serializeFrontmatter(memoryToFrontmatter(memory), memory.body)
}

/** Read a single memory file; `null` if missing or invalid (bad/missing frontmatter). */
export async function readMemoryFile(filePath: string): Promise<Memory | null> {
  let text: string
  try {
    text = await fs.readFile(filePath, "utf8")
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") return null
    throw err
  }
  const parsed = parseFrontmatter(text)
  if (!parsed) return null
  const memory = frontmatterToMemory(parsed.frontmatter)
  if (!memory) return null
  memory.body = parsed.body
  return memory
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir)
    return names.filter((n) => n.startsWith("mem-") && n.endsWith(".md"))
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") return []
    throw err
  }
}

async function readMemories(dir: string): Promise<Memory[]> {
  const files = await listFiles(dir)
  const out: Memory[] = []
  for (const name of files) {
    const memory = await readMemoryFile(path.join(dir, name))
    if (memory) out.push(memory)
  }
  return out
}

/** List merged (active) memories. */
export function listActiveMemories(projectDir: string): Promise<Memory[]> {
  return readMemories(activeDir(projectDir))
}

/** List retired memories. */
export function listRetiredMemories(projectDir: string): Promise<Memory[]> {
  return readMemories(retiredDir(projectDir))
}

/** List the agent's staged proposals. */
export function listStagedProposals(projectDir: string): Promise<Memory[]> {
  return readMemories(stagingDir(projectDir))
}

export type MemoryWithStatus = { memory: Memory; status: MemoryStatus }

/** Read one memory by id from active, then retired, then staging. */
export async function readMemoryById(projectDir: string, id: string): Promise<MemoryWithStatus | null> {
  const locations: Array<[string, MemoryStatus]> = [
    [activeDir(projectDir), "active"],
    [retiredDir(projectDir), "retired"],
    [stagingDir(projectDir), "staging"],
  ]
  for (const [dir, status] of locations) {
    const memory = await readMemoryFile(path.join(dir, `${id}.md`))
    if (memory) return { memory, status }
  }
  return null
}

// ─── Write ──────────────────────────────────────────────────────────────────

/**
 * Thrown when a proposal cannot be written because its staging path is
 * unwritable or read-only. Carries a clean, user-facing message; tools catch it
 * and return that message instead of surfacing a raw EACCES.
 */
export class StoreWriteError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "StoreWriteError"
  }
}

/** Write a memory file into `dir` (creating it). Used by migration and the bot. */
export async function writeMemoryFile(dir: string, memory: Memory): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${memory.id}.md`), serializeMemory(memory), "utf8")
}

/**
 * Write a proposal file to `.memory/staging/`. Unwritable/read-only paths raise
 * a descriptive StoreWriteError.
 */
export async function writeProposal(projectDir: string, memory: Memory): Promise<void> {
  const dir = stagingDir(projectDir)
  try {
    await writeMemoryFile(dir, memory)
  } catch (err: unknown) {
    if (
      isNodeError(err) &&
      (err.code === "EACCES" || err.code === "EPERM" || err.code === "EROFS" || err.code === "ENOTDIR")
    ) {
      throw new StoreWriteError(
        `Cannot save memory: the staging path "${path.join(dir, `${memory.id}.md`)}" is not writable. OpenCode must run inside a writable project directory (not "/" or a read-only filesystem).`,
        err,
      )
    }
    throw err
  }
}

// ─── Moves (used by migration and the bot) ───────────────────────────────────

/** Move an active memory to `retired/`. */
export async function moveToRetired(projectDir: string, id: string): Promise<void> {
  const from = path.join(activeDir(projectDir), `${id}.md`)
  const to = path.join(retiredDir(projectDir), `${id}.md`)
  await fs.mkdir(retiredDir(projectDir), { recursive: true })
  await fs.rename(from, to)
}

/** Move a retired memory back to `active/`. */
export async function moveToActive(projectDir: string, id: string): Promise<void> {
  const from = path.join(retiredDir(projectDir), `${id}.md`)
  const to = path.join(activeDir(projectDir), `${id}.md`)
  await fs.mkdir(activeDir(projectDir), { recursive: true })
  await fs.rename(from, to)
}

// ─── Author ─────────────────────────────────────────────────────────────────

export type GitConfigReader = (key: string, cwd: string) => Promise<string | null>

const defaultGitReader: GitConfigReader = (key, cwd) =>
  new Promise((resolve) => {
    execFile("git", ["config", key], { cwd }, (err, stdout) => {
      if (err) return resolve(null)
      const value = stdout.trim()
      resolve(value.length > 0 ? value : null)
    })
  })

/**
 * Resolve the author for a proposal: `git config user.name`, falling back to
 * `user.email`, then `"unknown"` on any failure. `read` is injectable for tests.
 */
export async function resolveAuthor(cwd: string, read: GitConfigReader = defaultGitReader): Promise<string> {
  const name = await read("user.name", cwd)
  if (name) return name
  const email = await read("user.email", cwd)
  if (email) return email
  return "unknown"
}

// ─── Aging ──────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Age of a memory in whole days, from the later of `approved_at`/`proposed_at`.
 * Returns `NaN` when there is no usable timestamp.
 */
export function memoryAge(memory: Memory, now: Date): number {
  const stamp = memory.approvedAt ?? memory.proposedAt
  if (!stamp) return Number.NaN
  const t = Date.parse(stamp)
  return Number.isNaN(t) ? Number.NaN : Math.floor((now.getTime() - t) / DAY_MS)
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err
}
