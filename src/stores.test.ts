import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { DEFAULT_CONFIG, type PluginConfig } from "./types.js"
import {
  availableStores,
  projectStoreUsable,
  resolveStores,
  usableProjectStore,
  withStoreAccess,
  type StoreSet,
} from "./stores.js"
import { defaultGitRun, resetProjectStoreCache } from "./projectStore.js"

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** One scratch Git repository with a remote default branch carrying a memory. */
async function withGitFixture<T>(fn: (fx: { root: string; dev: string; home: string }) => Promise<T>): Promise<T> {
  const root = await tempDir("mem-stores-git-")
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
      "---\nid: mem-aaaaaaaa\ntitle: Initial remote memory\n---\nbody\n",
      "utf8",
    )
    await defaultGitRun(["add", "-A"], dev)
    await defaultGitRun(["commit", "-qm", "init"], dev)
    await defaultGitRun(["branch", "-M", "main"], dev)
    await defaultGitRun(["push", "-q", "-u", "origin", "main"], dev)
    resetProjectStoreCache()
    return await fn({ root, dev, home })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

function config(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return { ...DEFAULT_CONFIG, ...overrides }
}

// ─── Availability boundary ─────────────────────────────────────────────────

describe("availableStores: availability boundary", () => {
  it("omits an unavailable project store instead of reading it as empty", () => {
    const stores: StoreSet = {
      global: { scope: "global", root: "/global" },
      project: { scope: "project", root: "/managed-project" },
      projectProblem: "unavailable",
      defaultScope: "global",
      globalPath: "/global",
    }
    assert.deepEqual(availableStores(stores).map((s) => s.scope), ["global"])
    assert.equal(usableProjectStore(stores), null)
    assert.equal(projectStoreUsable(stores), false)
  })

  it("treats the global and non-Git stores as having no access lease", async () => {
    const globalStore = { scope: "global" as const, root: "/global" }
    const plainStore = { scope: "project" as const, root: "/plain" }
    let ran = 0
    await withStoreAccess(globalStore, async () => {
      ran++
    })
    await withStoreAccess(plainStore, async () => {
      ran++
    })
    assert.equal(ran, 2)
  })

  it("keeps both stores when the project store is available", () => {
    const stores: StoreSet = {
      global: { scope: "global", root: "/global" },
      project: { scope: "project", root: "/managed-project" },
      defaultScope: "global",
      globalPath: "/global",
    }
    assert.deepEqual(availableStores(stores).map((s) => s.scope), ["global", "project"])
    assert.deepEqual(usableProjectStore(stores), { scope: "project", root: "/managed-project" })
    assert.equal(projectStoreUsable(stores), true)
  })
})

// ─── Plain directories keep the historical project store ────────────────────

describe("resolveStores: plain directory", () => {
  it("uses the session directory as the project store and degrades to project-only memory", async () => {
    const dir = await tempDir("mem-stores-plain-")
    const home = path.join(dir, "home")
    await fs.mkdir(home)
    try {
      const stores = await resolveStores(dir, config(), { home, probe: async () => "missing" })
      assert.equal(stores.project.root, dir)
      assert.equal(stores.projectProblem, undefined)
      assert.equal(stores.global, undefined)
      assert.equal(stores.globalProblem, "missing")
      assert.equal(stores.defaultScope, "project")
      assert.deepEqual(availableStores(stores).map((s) => s.scope), ["project"])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("keeps the configured default scope when the global store is readable", async () => {
    const dir = await tempDir("mem-stores-global-")
    const home = path.join(dir, "home")
    const global = path.join(home, "memory")
    await fs.mkdir(global, { recursive: true })
    try {
      const stores = await resolveStores(dir, config({ globalMemoryPath: global }), { home })
      assert.equal(stores.project.root, dir)
      assert.equal(stores.global?.root, global)
      assert.equal(stores.defaultScope, DEFAULT_CONFIG.defaultScope)
      assert.deepEqual(availableStores(stores).map((s) => s.scope), ["global", "project"])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("reports a disabled global store without probing", async () => {
    const dir = await tempDir("mem-stores-disabled-")
    try {
      let probed = false
      const stores = await resolveStores(dir, config({ globalMemoryEnabled: false }), {
        home: dir,
        probe: async () => {
          probed = true
          return "dir"
        },
      })
      assert.equal(probed, false)
      assert.equal(stores.globalProblem, "disabled")
      assert.equal(stores.defaultScope, "project")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("reports an unreadable global store", async () => {
    const dir = await tempDir("mem-stores-unreadable-")
    try {
      const stores = await resolveStores(dir, config(), {
        home: dir,
        probe: async () => {
          throw new Error("EACCES")
        },
      })
      assert.equal(stores.globalProblem, "unreadable")
      assert.equal(stores.defaultScope, "project")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

// ─── Git projects use the managed worktree ─────────────────────────────────

describe("resolveStores: Git project", () => {
  it("uses the managed worktree, not the developer checkout, from any subdirectory", async () => {
    await withGitFixture(async (fx) => {
      const fromRoot = await resolveStores(fx.dev, config(), { home: fx.home, project: { forceRefresh: true } })
      assert.equal(fromRoot.projectProblem, undefined)
      assert.notEqual(fromRoot.project.root, fx.dev)
      assert.ok(fromRoot.project.root.startsWith(path.join(fx.home, ".local", "share", "opencode", "project-memory")))
      assert.equal(fromRoot.projectInputRoot, await fs.realpath(fx.dev))
      assert.equal(fromRoot.projectManaged, true)
      assert.ok(fromRoot.project.access, "managed store carries its cross-process lease descriptor")

      const nested = path.join(fx.dev, "source", "nested")
      await fs.mkdir(nested, { recursive: true })
      const fromSubdir = await resolveStores(nested, config(), { home: fx.home, project: { forceRefresh: true } })
      assert.equal(fromSubdir.project.root, fromRoot.project.root)
    })
  })

  it("reports an unusable managed store instead of falling back to the checkout", async () => {
    await withGitFixture(async (fx) => {
      const failing = async (args: string[], cwd: string): Promise<string> => {
        if (args[0] === "worktree" && args[1] === "add") throw new Error("simulated initialization failure")
        return defaultGitRun(args, cwd)
      }
      const stores = await resolveStores(fx.dev, config(), {
        home: fx.home,
        project: { forceRefresh: true, git: failing },
      })
      assert.equal(stores.projectProblem, "unavailable")
      assert.notEqual(stores.project.root, fx.dev)
      assert.ok(stores.project.root.startsWith(path.join(fx.home, ".local", "share", "opencode", "project-memory")))
    })
  })

  it("automatically fast-forwards a clean global store clone and preserves untracked staging", async () => {
    const root = await tempDir("mem-global-sync-")
    const remote = path.join(root, "global-remote.git")
    const publisher = path.join(root, "publisher")
    const globalClone = path.join(root, "global-clone")
    const projectDir = path.join(root, "plain-project")
    const home = path.join(root, "home")
    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(home, { recursive: true })
    try {
      await defaultGitRun(["init", "-q", "--bare", remote], root)
      await defaultGitRun(["clone", "-q", remote, publisher], root)
      await defaultGitRun(["config", "user.email", "test@example.com"], publisher)
      await defaultGitRun(["config", "user.name", "Test"], publisher)
      await fs.mkdir(path.join(publisher, "memory", "active"), { recursive: true })
      await fs.writeFile(
        path.join(publisher, "memory", "active", "mem-gggg0001.md"),
        "---\nid: mem-gggg0001\ntitle: First global rule\n---\nbody\n",
        "utf8",
      )
      await defaultGitRun(["add", "-A"], publisher)
      await defaultGitRun(["commit", "-qm", "init"], publisher)
      await defaultGitRun(["branch", "-M", "main"], publisher)
      await defaultGitRun(["push", "-q", "-u", "origin", "main"], publisher)

      await defaultGitRun(["clone", "-q", remote, globalClone], root)
      await fs.mkdir(path.join(globalClone, ".memory", "staging"), { recursive: true })
      await fs.writeFile(path.join(globalClone, ".memory", "staging", "mem-staged99.md"), "staged\n", "utf8")

      // Merge a new global memory upstream.
      await fs.writeFile(
        path.join(publisher, "memory", "active", "mem-gggg0002.md"),
        "---\nid: mem-gggg0002\ntitle: Newly merged global rule\n---\nbody\n",
        "utf8",
      )
      await defaultGitRun(["add", "-A"], publisher)
      await defaultGitRun(["commit", "-qm", "add second"], publisher)
      await defaultGitRun(["push", "-q", "origin", "main"], publisher)

      resetProjectStoreCache()
      const stores = await resolveStores(projectDir, config({ globalMemoryPath: globalClone }), {
        home,
        global: { forceRefresh: true },
      })
      assert.equal(stores.global?.root, globalClone)
      assert.ok(stores.global?.access, "Git-backed global store carries a cross-process lease")
      await fs.access(path.join(globalClone, "memory", "active", "mem-gggg0002.md"))
      assert.equal(await fs.readFile(path.join(globalClone, ".memory", "staging", "mem-staged99.md"), "utf8"), "staged\n")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("skips fast-forwarding the global clone when tracked files have local edits, without failing the session", async () => {
    const root = await tempDir("mem-global-dirty-")
    const remote = path.join(root, "global-remote.git")
    const publisher = path.join(root, "publisher")
    const globalClone = path.join(root, "global-clone")
    const projectDir = path.join(root, "plain-project")
    const home = path.join(root, "home")
    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(home, { recursive: true })
    try {
      await defaultGitRun(["init", "-q", "--bare", remote], root)
      await defaultGitRun(["clone", "-q", remote, publisher], root)
      await defaultGitRun(["config", "user.email", "test@example.com"], publisher)
      await defaultGitRun(["config", "user.name", "Test"], publisher)
      await fs.mkdir(path.join(publisher, "memory", "active"), { recursive: true })
      const tracked = path.join("memory", "active", "mem-gggg0001.md")
      await fs.writeFile(path.join(publisher, tracked), "---\nid: mem-gggg0001\ntitle: Original\n---\nbody\n", "utf8")
      await defaultGitRun(["add", "-A"], publisher)
      await defaultGitRun(["commit", "-qm", "init"], publisher)
      await defaultGitRun(["branch", "-M", "main"], publisher)
      await defaultGitRun(["push", "-q", "-u", "origin", "main"], publisher)

      await defaultGitRun(["clone", "-q", remote, globalClone], root)

      // Advance upstream and make a local tracked edit in the global clone.
      await fs.writeFile(
        path.join(publisher, "memory", "active", "mem-gggg0002.md"),
        "---\nid: mem-gggg0002\ntitle: Upstream addition\n---\nbody\n",
        "utf8",
      )
      await defaultGitRun(["add", "-A"], publisher)
      await defaultGitRun(["commit", "-qm", "upstream"], publisher)
      await defaultGitRun(["push", "-q", "origin", "main"], publisher)

      const localEdit = "---\nid: mem-gggg0001\ntitle: Local edit\n---\nbody\n"
      await fs.writeFile(path.join(globalClone, tracked), localEdit, "utf8")

      resetProjectStoreCache()
      const stores = await resolveStores(projectDir, config({ globalMemoryPath: globalClone }), {
        home,
        global: { forceRefresh: true },
      })
      assert.equal(stores.global?.root, globalClone)
      assert.equal(stores.globalProblem, undefined)
      assert.equal(await fs.readFile(path.join(globalClone, tracked), "utf8"), localEdit)
      await assert.rejects(fs.access(path.join(globalClone, "memory", "active", "mem-gggg0002.md")))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
