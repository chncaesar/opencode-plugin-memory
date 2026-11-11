#!/usr/bin/env node
/**
 * The memory bot — the only component that holds repository credentials and
 * runs git. It watches the git-ignored `.memory/staging/` folder and turns
 * each staged proposal into a pull request:
 *
 *   propose → branch, commit the file into `memory/active/` (moving any
 *             `supersedes` targets to `memory/retired/`), open a PR, remove the
 *             staged file.
 *   retire  → move `memory/active/<id>` to `memory/retired/` with a reason,
 *             open a PR, remove the staged file.
 *
 * It never edits `_summary.md`; CI regenerates the index on merge.
 *
 * Invocation (as a developer-machine daemon or CLI):
 *   node dist/bot.js once       process staged proposals, then exit
 *   node dist/bot.js watch      poll staging forever (default interval 2s)
 *   node dist/bot.js regenerate regenerate memory/_summary.md (used by CI)
 */
import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { execFile } from "child_process"
import {
  activeDir,
  listStagedProposals,
  readMemoryFile,
  retiredDir,
  stagingDir,
  writeMemoryFile,
} from "./storage.js"
import { generateSummary } from "./summary.js"
import type { Memory } from "./types.js"

// ─── Child processes ─────────────────────────────────────────────────────────

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} ${args.join(" ")}: ${(stderr || err.message).trim()}`))
        return
      }
      resolve(stdout.trim())
    })
  })
}

function git(args: string[], cwd: string): Promise<string> {
  return run("git", args, cwd)
}

function gh(args: string[], cwd: string): Promise<string> {
  return run("gh", args, cwd)
}

/** The repository's default branch (main/master), used as the PR base. */
export async function defaultBranch(cwd: string): Promise<string> {
  try {
    const name = await gh(["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], cwd)
    if (name) return name
  } catch {
    // fall through to git fallback
  }
  try {
    const ref = await git(["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd)
    if (ref) return ref.replace(/^origin\//, "")
  } catch {
    // fall through
  }
  return "main"
}

// ─── Pure filesystem transforms (no git) ────────────────────────────────────

/**
 * Promote a `propose` proposal into `memory/active/`, retiring any superseded
 * memories. Does NOT remove the staged file (the orchestrator does that only
 * after the PR opens). Idempotent: re-running overwrites the active file and
 * skips supersede targets that are already gone.
 *
 * Returns the list of filesystem paths changed (for logging).
 */
export async function applyPropose(projectDir: string, memory: Memory): Promise<string[]> {
  const promoted: Memory = { ...memory }
  delete promoted.intent // staging-only directive, never written to active/

  await writeMemoryFile(activeDir(projectDir), promoted)
  const changed = [path.join(activeDir(projectDir), `${memory.id}.md`)]

  for (const oldId of memory.supersedes ?? []) {
    const old = await readMemoryFile(path.join(activeDir(projectDir), `${oldId}.md`))
    if (!old) continue // already retired (idempotent re-run)
    old.supersededBy = memory.id
    old.retiredReason = "superseded"
    old.retiredAt = new Date().toISOString()
    await writeMemoryFile(retiredDir(projectDir), old)
    await fs.rm(path.join(activeDir(projectDir), `${oldId}.md`), { force: true })
    changed.push(path.join(retiredDir(projectDir), `${oldId}.md`))
  }

  return changed
}

/**
 * Promote a `retire` proposal: move `memory/active/<id>` to `memory/retired/`
 * with the reason from the staged file. Does NOT remove the staged file.
 * Idempotent: a missing active file means it was already retired.
 */
export async function applyRetire(projectDir: string, staged: Memory): Promise<string[]> {
  const id = staged.id
  const active = await readMemoryFile(path.join(activeDir(projectDir), `${id}.md`))
  if (!active) return [] // already retired

  active.retiredReason = staged.retiredReason ?? "stale"
  active.retiredAt = new Date().toISOString()
  if (staged.supersededBy) active.supersededBy = staged.supersededBy
  await writeMemoryFile(retiredDir(projectDir), active)
  await fs.rm(path.join(activeDir(projectDir), `${id}.md`), { force: true })
  return [path.join(retiredDir(projectDir), `${id}.md`)]
}

// ─── PR title / body template ───────────────────────────────────────────────

const CHECKLIST = [
  "True — correct today",
  "Relevant — points at something that still exists",
  "Useful — a future session would waste time re-learning it if absent",
  "Scoped — one entry, one rule",
  "Clean — no secrets, no customer data, no credentials",
  "Not a duplicate — checked against active and proposed memories",
]

export function buildPrTitle(memory: Memory): string {
  if (memory.intent === "retire") return `memory: retire ${memory.id}`
  const title = memory.title.length > 72 ? `${memory.title.slice(0, 72)}…` : memory.title
  return `memory: ${title}`
}

export function buildPrBody(memory: Memory): string {
  const lines: string[] = ["## Memory proposal", ""]
  lines.push(`- **ID**: \`${memory.id}\``)
  lines.push(`- **Title**: ${memory.title}`)
  if (memory.author) lines.push(`- **Author**: ${memory.author}`)
  if (memory.intent === "retire") {
    lines.push(`- **Intent**: retire (reason: ${memory.retiredReason ?? "stale"})`)
    if (memory.supersededBy) lines.push(`- **Superseded by**: \`${memory.supersededBy}\``)
  } else {
    lines.push(`- **Intent**: propose`)
    if (memory.supersedes?.length) lines.push(`- **Supersedes**: ${memory.supersedes.map((id) => `\`${id}\``).join(", ")}`)
    if (memory.tags?.length) lines.push(`- **Tags**: ${memory.tags.join(", ")}`)
  }
  lines.push("")
  lines.push("Merging this PR makes the memory active. Review against the memory checklist:")
  lines.push("")
  for (const item of CHECKLIST) lines.push(`- ${item}`)
  if (memory.source) lines.push("", `Source: ${memory.source}`)
  return lines.join("\n")
}

// ─── Orchestration ──────────────────────────────────────────────────────────

export type BotOptions = {
  /** Working directory (defaults to process.cwd()). */
  cwd?: string
  /** Log a line; defaults to console.error. */
  log?: (line: string) => void
}

export type BotResult = {
  /** Number of staged proposals successfully turned into PRs. */
  promoted: number
  /** Number of staged proposals left in place (branch already existed, PR failed). */
  skipped: number
}

/**
 * Process every staged proposal once. For each:
 *   1. skip if a branch `memory/<id>` already exists (PR already opened);
 *   2. branch off the default branch, apply the transform, commit, push, open PR;
 *   3. on success remove the staged file; on failure leave it for the next poll.
 */
export async function processStagingOnce(projectDir: string, opts: BotOptions = {}): Promise<BotResult> {
  const cwd = opts.cwd ?? projectDir
  const log = opts.log ?? ((line: string) => console.error(line))

  const staged = await listStagedProposals(projectDir)
  if (staged.length === 0) return { promoted: 0, skipped: 0 }

  const base = await defaultBranch(cwd)
  await git(["checkout", base], cwd)
  try {
    await git(["pull", "--ff-only"], cwd)
  } catch {
    // best-effort; a stale base is acceptable
  }

  let promoted = 0
  let skipped = 0

  // Process deterministically (by id) so behaviour is stable across runs.
  for (const memory of [...staged].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const branch = `memory/${memory.id}`
    if (await branchExists(cwd, branch)) {
      log(`skip ${memory.id}: branch ${branch} already exists`)
      skipped++
      continue
    }

    await git(["checkout", "-b", branch], cwd)
    try {
      const changed =
        memory.intent === "retire" ? await applyRetire(projectDir, memory) : await applyPropose(projectDir, memory)
      if (changed.length === 0) {
        log(`skip ${memory.id}: nothing to change`)
        await git(["checkout", base], cwd)
        skipped++
        continue
      }

      await git(["add", "memory/active", "memory/retired"], cwd)
      await git(["commit", "-m", commitMessage(memory)], cwd)
      await git(["push", "-u", "origin", branch], cwd)
      await gh(["pr", "create", "--base", base, "--head", branch, "--title", buildPrTitle(memory), "--body", buildPrBody(memory)], cwd)

      await fs.rm(path.join(stagingDir(projectDir), `${memory.id}.md`), { force: true })
      log(`promoted ${memory.id} (${memory.intent === "retire" ? "retire" : "propose"})`)
      promoted++
    } finally {
      await git(["checkout", base], cwd).catch(() => undefined)
    }
  }

  return { promoted, skipped }
}

function commitMessage(memory: Memory): string {
  if (memory.intent === "retire") return `memory: retire ${memory.id}`
  const title = memory.title.length > 60 ? `${memory.title.slice(0, 60)}…` : memory.title
  return `memory: add ${memory.id} — ${title}`
}

async function branchExists(cwd: string, name: string): Promise<boolean> {
  for (const ref of [name, `origin/${name}`]) {
    try {
      await git(["rev-parse", "--verify", "--quiet", ref], cwd)
      return true
    } catch {
      // not found — check the next ref
    }
  }
  return false
}

// ─── Watch / regenerate / CLI ───────────────────────────────────────────────

/** Poll staging forever, processing new proposals as they appear. */
export async function startWatch(projectDir: string, intervalMs: number, opts: BotOptions = {}): Promise<void> {
  const log = opts.log ?? ((line: string) => console.error(line))
  // Process immediately, then on an interval.
  for (;;) {
    try {
      const result = await processStagingOnce(projectDir, opts)
      if (result.promoted > 0) log(`promoted ${result.promoted} proposal${result.promoted === 1 ? "" : "s"}`)
    } catch (err) {
      log(`bot error: ${err instanceof Error ? err.message : String(err)}`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

function printUsage(): void {
  console.error(
    [
      "opencode-memory-bot — turn staged memory proposals into pull requests",
      "",
      "Usage:",
      "  node dist/bot.js once [--dir <path>]        process staged proposals, then exit",
      "  node dist/bot.js watch [--dir <path>] [--interval <ms>]   poll staging forever",
      "  node dist/bot.js regenerate [--dir <path>]  regenerate memory/_summary.md",
    ].join("\n"),
  )
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0] ?? "once"
  const dirArg = argv.includes("--dir") ? argv[argv.indexOf("--dir") + 1] : undefined
  const projectDir = path.resolve(dirArg ?? process.cwd())
  const intervalArg = argv.includes("--interval") ? argv[argv.indexOf("--interval") + 1] : undefined
  const intervalMs = intervalArg ? Number(intervalArg) || 2000 : 2000

  switch (command) {
    case "once": {
      const result = await processStagingOnce(projectDir)
      if (result.promoted > 0) console.log(`promoted ${result.promoted} proposal${result.promoted === 1 ? "" : "s"}`)
      else if (result.skipped > 0) console.log(`skipped ${result.skipped} proposal${result.skipped === 1 ? "" : "s"}`)
      else console.log("no staged proposals")
      return
    }
    case "watch": {
      console.error(`watching ${path.join(projectDir, ".memory", "staging")} every ${intervalMs}ms`)
      await startWatch(projectDir, intervalMs)
      return
    }
    case "regenerate": {
      await generateSummary(projectDir)
      console.log(`regenerated ${path.join(projectDir, "memory", "_summary.md")}`)
      return
    }
    case "help":
    case "--help":
    case "-h":
      printUsage()
      return
    default:
      printUsage()
      process.exitCode = 2
  }
}

// Run the CLI only when executed directly (not when imported by tests).
const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
