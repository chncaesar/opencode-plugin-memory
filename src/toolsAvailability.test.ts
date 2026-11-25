import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { createMemoryTools } from "./tools.js"
import { resolveStores, type StoreSet } from "./stores.js"
import { defaultGitRun, resolveProjectStore, resetProjectStoreCache, type GitRun } from "./projectStore.js"
import { activeDir, listStagedProposals, writeMemoryFile } from "./storage.js"
import { DEFAULT_CONFIG } from "./types.js"
import type { Logger } from "./logging.js"

/**
 * The availability boundary at the tool level: an unavailable project store is
 * never written through and never shown as an empty source of truth.
 */

const logger: Logger = {
  async info() {},
  async error() {},
}
const PROJECT_ONLY = { ...DEFAULT_CONFIG, globalMemoryEnabled: false }

type Out = { title: string; output: string }
async function run(tool: unknown, args: Record<string, unknown>, dir: string): Promise<Out> {
  const t = tool as { execute: (a: unknown, c: unknown) => Promise<Out | string> }
  const r = await t.execute(args, { directory: dir })
  return typeof r === "string" ? { title: "", output: r } : r
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

/** Scratch Git repository whose managed store cannot be initialized. */
async function withFailedGitStore<T>(
  fn: (ctx: { dev: string; home: string; unavailableRoot: string }) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mem-tools-availability-"))
  const remote = path.join(root, "remote.git")
  const dev = path.join(root, "dev")
  const home = path.join(root, "home")
  await fs.mkdir(home, { recursive: true })
  try {
    await defaultGitRun(["init", "-q", "--bare", remote], root)
    await defaultGitRun(["clone", "-q", remote, dev], root)
    await defaultGitRun(["config", "user.email", "test@example.com"], dev)
    await defaultGitRun(["config", "user.name", "Test"], dev)
    await fs.mkdir(path.join(dev, "memory", "active"), { recursive: true })
    await fs.writeFile(
      path.join(dev, "memory", "active", "mem-aaaaaaaa.md"),
      "---\nid: mem-aaaaaaaa\ntitle: Remote memory\n---\nbody\n",
      "utf8",
    )
    await defaultGitRun(["add", "-A"], dev)
    await defaultGitRun(["commit", "-qm", "init"], dev)
    await defaultGitRun(["branch", "-M", "main"], dev)
    await defaultGitRun(["push", "-q", "-u", "origin", "main"], dev)

    const failing: GitRun = async (args, cwd) => {
      if (args[0] === "worktree" && args[1] === "add") throw new Error("simulated initialization failure")
      return defaultGitRun(args, cwd)
    }
    resetProjectStoreCache()
    const unavailable = await resolveProjectStore(dev, { home, forceRefresh: true, git: failing })
    assert.equal(unavailable.status, "unavailable")
    return await fn({ dev, home, unavailableRoot: unavailable.root })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function withGitStore<T>(
  fn: (ctx: { dev: string; home: string; initial: Awaited<ReturnType<typeof resolveProjectStore>> }) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mem-tools-git-"))
  const remote = path.join(root, "remote.git")
  const dev = path.join(root, "dev")
  const home = path.join(root, "home")
  await fs.mkdir(home, { recursive: true })
  try {
    await defaultGitRun(["init", "-q", "--bare", remote], root)
    await defaultGitRun(["clone", "-q", remote, dev], root)
    await defaultGitRun(["config", "user.email", "test@example.com"], dev)
    await defaultGitRun(["config", "user.name", "Test"], dev)
    await fs.mkdir(path.join(dev, "memory", "active"), { recursive: true })
    await fs.writeFile(
      path.join(dev, "memory", "active", "mem-aaaaaaaa.md"),
      "---\nid: mem-aaaaaaaa\ntitle: Initial memory\n---\nbody\n",
      "utf8",
    )
    await defaultGitRun(["add", "-A"], dev)
    await defaultGitRun(["commit", "-qm", "init"], dev)
    await defaultGitRun(["branch", "-M", "main"], dev)
    await defaultGitRun(["push", "-q", "-u", "origin", "main"], dev)
    resetProjectStoreCache()
    const initial = await resolveProjectStore(dev, { home, forceRefresh: true })
    return await fn({ dev, home, initial })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

describe("tools: proposal waits for a paused refresh", () => {
  it("does not write staging until the refresh lease is released", async () => {
    await withGitStore(async ({ dev, home, initial }) => {
      assert.equal(initial.status, "managed")
      const access = { base: path.dirname(initial.managedRoot!), name: path.basename(initial.managedRoot!) }
      const stores: StoreSet = {
        project: { scope: "project", root: initial.root, access },
        projectInputRoot: await fs.realpath(dev),
        projectManaged: true,
        defaultScope: "project",
        globalPath: "",
        globalProblem: "disabled",
      }
      const tools = createMemoryTools(PROJECT_ONLY, logger, async () => stores)

      // Change the remote so the paused refresh has real work to do.
      await fs.writeFile(
        path.join(dev, "memory", "active", "mem-bbbbbbbb.md"),
        "---\nid: mem-bbbbbbbb\ntitle: New remote\n---\nbody\n",
        "utf8",
      )
      await defaultGitRun(["add", "-A"], dev)
      await defaultGitRun(["commit", "-qm", "remote"], dev)
      await defaultGitRun(["push", "-q", "origin", "main"], dev)
      const target = await defaultGitRun(["rev-parse", "origin/main"], dev)

      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let markStarted!: () => void
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      const paused: GitRun = async (args, cwd) => {
        if (args[0] === "reset" && args[2] === target) {
          markStarted()
          await gate
        }
        return defaultGitRun(args, cwd)
      }

      const refreshing = resolveProjectStore(dev, { home, forceRefresh: true, git: paused })
      await started

      let proposed: Out | null = null
      const proposing = run(
        tools.memory_propose,
        { title: "Blocked proposal", content: "content unique to this proposal" },
        dev,
      ).then((r) => {
        proposed = r
        return r
      })
      await new Promise((resolve) => setTimeout(resolve, 80))
      assert.equal(proposed, null, "proposal must not run while the refresh holds the lease")
      assert.equal((await listStagedProposals(initial.root)).length, 0)

      release()
      await refreshing
      const result = await proposing
      assert.match(result.title, /Memory proposed/)
      assert.equal((await listStagedProposals(initial.root)).length, 1)
    })
  })
})

describe("tools: unavailable project store", () => {
  it("fails project-targeted writes without creating any staging file", async () => {
    await withFailedGitStore(async ({ dev, home, unavailableRoot }) => {
      // Resolve through the real resolver with the same failing Git runner.
      const failing: GitRun = async (args, cwd) => {
        if (args[0] === "worktree" && args[1] === "add") throw new Error("simulated initialization failure")
        return defaultGitRun(args, cwd)
      }
      const resolve = (directory: string) =>
        resolveStores(directory, PROJECT_ONLY, { home, project: { forceRefresh: true, git: failing } })
      const tools = createMemoryTools(PROJECT_ONLY, logger, resolve)

      const propose = await run(tools.memory_propose, { title: "New rule", content: "Body." }, dev)
      assert.equal(propose.title, "Memory not proposed")
      assert.match(propose.output, /project memory store is unavailable/i)

      const update = await run(tools.memory_update, { id: "mem-aaaaaaaa", content: "changed" }, dev)
      assert.equal(update.title, "Project memory unavailable")
      assert.match(update.output, /unavailable/i)

      const retire = await run(tools.memory_delete, { id: "mem-aaaaaaaa", reason: "stale" }, dev)
      assert.equal(retire.title, "Project memory unavailable")

      const publish = await run(tools.memory_publish, {}, dev)
      assert.match(publish.output, /Project store: unavailable/i)

      const read = await run(tools.memory_read, {}, dev)
      assert.match(read.output, /Project store: unavailable/i)
      const review = await run(tools.memory_review, {}, dev)
      assert.match(review.output, /## Project store/)

      // Nothing was written into the developer checkout or the uninitialized
      // managed path.
      assert.equal((await listStagedProposals(dev)).length, 0)
      assert.equal((await listStagedProposals(unavailableRoot)).length, 0)
      assert.equal(await exists(path.join(dev, ".memory")), false)
      assert.equal(await exists(path.join(unavailableRoot, ".memory")), false)
    })
  })

  it("still uses an available global store without treating the project as empty", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mem-tools-global-"))
    const globalRoot = path.join(root, "global")
    const projectRoot = path.join(root, "uninitialized-managed-store")
    try {
      await writeMemoryFile(activeDir(globalRoot), {
        id: "mem-gggggggg",
        title: "Global rule",
        body: "global body",
        proposedAt: "2026-01-01",
        approvedAt: "2026-01-01",
      })
      const stores: StoreSet = {
        global: { scope: "global", root: globalRoot },
        project: { scope: "project", root: projectRoot },
        projectProblem: "unavailable",
        defaultScope: "global",
        globalPath: globalRoot,
      }
      const tools = createMemoryTools(DEFAULT_CONFIG, logger, async () => stores)

      const read = await run(tools.memory_read, {}, root)
      assert.match(read.output, /\[mem-gggggggg\] Global rule/)
      assert.match(read.output, /Project store: unavailable/i)

      const propose = await run(tools.memory_propose, { title: "New global rule", content: "usable" }, root)
      assert.match(propose.title, /Memory proposed/)
      assert.match(propose.output, /was not checked against project memories/)

      assert.equal((await listStagedProposals(globalRoot)).length, 1)
      assert.equal(await exists(path.join(projectRoot, ".memory")), false)
      assert.equal((await listStagedProposals(root)).length, 0)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
