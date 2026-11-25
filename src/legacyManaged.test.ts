import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { resolveStores, type StoreSet } from "./stores.js"
import { hasLegacyMemorySource, migrateProjectMemory } from "./migrate.js"
import { listActiveMemories, listRetiredMemories } from "./storage.js"
import { loadPromptBlock } from "./summary.js"
import { DEFAULT_CONFIG } from "./types.js"
import { defaultGitRun, resetProjectStoreCache } from "./projectStore.js"

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

const LEGACY = [
  "# OpenCode Memory",
  "<!-- nextSeq: 2 -->",
  "",
  "## Active",
  "",
  "### [MEM-001] Legacy rule",
  "- added: 2026-01-01",
  "Legacy body.",
  "",
  "## Archived",
  "",
].join("\n")

async function withGitProject<T>(fn: (fx: { root: string; dev: string; home: string }) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mem-legacy-managed-"))
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

    // The legacy file predates the plugin and is not part of the remote tree.
    await fs.mkdir(path.join(dev, ".opencode", "memory"), { recursive: true })
    await fs.writeFile(path.join(dev, ".opencode", "memory", "MEMORY.md"), LEGACY, "utf8")
    resetProjectStoreCache()
    return await fn({ root, dev, home })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

describe("legacy migration: managed Git project", () => {
  it("defers automatic import, leaves the legacy file untouched and converts nothing", async () => {
    await withGitProject(async ({ dev, home }) => {
      const stores = await resolveStores(dev, { ...DEFAULT_CONFIG, globalMemoryEnabled: false }, {
        home,
        project: { forceRefresh: true },
      })
      assert.equal(stores.projectProblem, undefined)
      assert.equal(stores.projectManaged, true)

      const converted = await migrateProjectMemory(stores)
      assert.equal(converted, 0)

      // The legacy file is still exactly what the developer had.
      assert.equal(await fs.readFile(path.join(dev, ".opencode", "memory", "MEMORY.md"), "utf8"), LEGACY)
      assert.equal(await hasLegacyMemorySource(stores.projectInputRoot!), true)

      // No converted active/retired entries and no migration sidecar.
      const active = await listActiveMemories(stores.project.root)
      assert.deepEqual(active.map((m) => m.title), ["Remote memory"])
      assert.deepEqual(await listRetiredMemories(stores.project.root), [])
      assert.equal(await exists(path.join(stores.project.root, "memory", ".migration.json")), false)

      // The prompt says import is deferred and the file is untouched; entries in
      // it are explicitly not active memories.
      const withWarning = await loadPromptBlock(stores, 4000, 0.7, undefined, { legacyImportDeferred: true })
      assert.match(withWarning, /Automatic import is deferred/)
      assert.match(withWarning, /legacy file is left untouched/)
      assert.match(withWarning, /not active memories/)
      const withoutWarning = await loadPromptBlock(stores, 4000, 0.7)
      assert.doesNotMatch(withoutWarning, /Automatic import is deferred/)
    })
  })
})

describe("legacy migration: plain directory", () => {
  it("keeps converting directly into the project directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-legacy-plain-"))
    try {
      await fs.mkdir(path.join(dir, ".opencode", "memory"), { recursive: true })
      await fs.writeFile(path.join(dir, ".opencode", "memory", "MEMORY.md"), LEGACY, "utf8")
      const stores: StoreSet = {
        project: { scope: "project", root: dir },
        projectInputRoot: dir,
        defaultScope: "project",
        globalPath: path.join(dir, "no-global"),
        globalProblem: "missing",
      }
      assert.equal(await migrateProjectMemory(stores), 1)
      assert.deepEqual((await listActiveMemories(dir)).map((m) => m.title), ["Legacy rule"])
      assert.equal(await fs.readFile(path.join(dir, ".opencode", "memory", "MEMORY.md"), "utf8"), LEGACY)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
