import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { withStoreAccess } from "./stores.js"
import {
  DEFAULT_REFRESH_INTERVAL_MS,
  REFRESH_MARKER_FILE,
  StoreAccessError,
  WORKTREE_MARKER,
  defaultGitRun,
  lockIsStale,
  managedPaths,
  projectStoreBase,
  resetProjectStoreCache,
  resolveProjectStore,
  withProjectStoreAccess,
  type GitRun,
} from "./projectStore.js"

// These tests run real Git against scratch remotes and developer checkouts; they
// never touch the user's real store (a temp home is always injected).

type Fixture = {
  root: string
  remote: string
  dev: string
  home: string
  base: string
}

async function withFixture<T>(fn: (fx: Fixture) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mem-project-"))
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
    await fs.mkdir(path.join(dev, "src"), { recursive: true })
    await fs.writeFile(path.join(dev, "memory", "active", "mem-aaaaaaaa.md"), memoryText("mem-aaaaaaaa", "Initial remote memory"), "utf8")
    await fs.writeFile(path.join(dev, "src", "app.ts"), "export const applicationSource = true\n", "utf8")
    await fs.writeFile(path.join(dev, "README.md"), "readme\n", "utf8")
    await defaultGitRun(["add", "-A"], dev)
    await defaultGitRun(["commit", "-qm", "init"], dev)
    await defaultGitRun(["branch", "-M", "main"], dev)
    await defaultGitRun(["push", "-q", "-u", "origin", "main"], dev)
    resetProjectStoreCache()
    return await fn({ root, remote, dev, home, base: projectStoreBase(home) })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

function memoryText(id: string, title: string, body = "Body"): string {
  return `---\nid: ${id}\ntitle: ${title}\n---\n${body}\n`
}

/** Commit a new memory to the scratch remote through the developer checkout. */
async function publishRemoteMemory(fx: Fixture, id: string, title: string): Promise<void> {
  await fs.writeFile(path.join(fx.dev, "memory", "active", `${id}.md`), memoryText(id, title), "utf8")
  await defaultGitRun(["add", "-A"], fx.dev)
  await defaultGitRun(["commit", "-qm", `add ${id}`], fx.dev)
  await defaultGitRun(["push", "-q", "origin", "main"], fx.dev)
}

async function checkoutState(dev: string): Promise<{ head: string; status: string; index: string; diff: string }> {
  return {
    head: await defaultGitRun(["rev-parse", "HEAD"], dev),
    status: await defaultGitRun(["status", "--porcelain=v1", "-uall"], dev),
    index: await defaultGitRun(["ls-files", "-s"], dev),
    diff: await defaultGitRun(["diff", "--binary"], dev),
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

function accessFor(res: { managedRoot?: string }): { base: string; name: string } {
  return { base: path.dirname(res.managedRoot!), name: path.basename(res.managedRoot!) }
}

async function writeRefreshMarker(
  fx: Fixture,
  res: { root: string; managedRoot?: string },
  previousHead: string | null,
  targetHead: string,
): Promise<string> {
  const marker = path.join(res.managedRoot!, REFRESH_MARKER_FILE)
  await fs.writeFile(
    marker,
    JSON.stringify(
      {
        owner: "opencode-plugin-memory",
        version: 1,
        identity: await fs.realpath(path.join(fx.dev, ".git")),
        worktree: res.root,
        previousHead,
        targetHead,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  )
  return marker
}

function failOn(predicate: (args: string[]) => boolean, message: string): GitRun {
  return async (args, cwd) => {
    if (predicate(args)) throw new Error(message)
    return defaultGitRun(args, cwd)
  }
}

/**
 * Build an owner directory + worktree directory by hand: a valid owner manifest,
 * runtime state inside the worktree, and a marker naming `markerRepository`.
 * Used to exercise the two-proof rule without relying on a partial git state.
 */
async function craftOwnerStore(fx: Fixture, markerRepository: string): Promise<{
  paths: ReturnType<typeof managedPaths>
  stagingFile: string
  markerFile: string
  markerText: string
}> {
  const identity = (await fs.realpath(path.join(fx.dev, ".git"))) as string
  const paths = managedPaths(identity, fx.base)
  await fs.mkdir(paths.ownerDir, { recursive: true })
  await fs.writeFile(
    paths.manifestFile,
    JSON.stringify(
      {
        owner: "opencode-plugin-memory",
        version: 1,
        repository: identity,
        worktree: paths.worktree,
        base: paths.ownerDir,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  )
  const stagingDir = path.join(paths.worktree, ".memory", "staging")
  await fs.mkdir(stagingDir, { recursive: true })
  const stagingFile = path.join(stagingDir, "mem-staged01.md")
  await fs.writeFile(stagingFile, "pending\n", "utf8")

  const markerFile = path.join(paths.worktree, WORKTREE_MARKER)
  const markerText =
    JSON.stringify(
      {
        owner: "opencode-plugin-memory",
        version: 1,
        repository: markerRepository,
        worktree: paths.worktree,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n"
  await fs.writeFile(markerFile, markerText, "utf8")
  return { paths, stagingFile, markerFile, markerText }
}

// ─── Non-Git projects ───────────────────────────────────────────────────────

describe("resolveProjectStore: plain directories", () => {
  it("keeps the session directory as the store root", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-plain-"))
    try {
      const res = await resolveProjectStore(dir, { home: path.join(dir, "home") })
      assert.equal(res.status, "project-dir")
      assert.equal(res.root, dir)
      assert.equal(res.problem, undefined)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("keeps that behaviour when Git itself is unavailable", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-plain-"))
    try {
      const broken: GitRun = async () => {
        throw new Error("git is unavailable")
      }
      const res = await resolveProjectStore(dir, { home: path.join(dir, "home"), git: broken })
      assert.equal(res.status, "project-dir")
      assert.equal(res.root, dir)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

// ─── Managed worktree creation ──────────────────────────────────────────────

describe("resolveProjectStore: managed worktree", () => {
  it("creates a sparse checkout outside the developer checkout with the memory tree only", async () => {
    await withFixture(async (fx) => {
      const res = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.equal(res.status, "managed")
      assert.equal(res.detail, undefined)
      assert.ok(res.repository)
      assert.ok(res.managedRoot)
      assert.ok(!res.root.startsWith(fx.dev + path.sep), "managed root must be outside the developer checkout")
      assert.ok(res.root.startsWith(fx.base + path.sep))
      assert.equal(res.root, managedPaths(res.commonDir!, fx.base).worktree)
      assert.equal(res.repository, await fs.realpath(fx.dev))
      assert.equal(res.commonDir, await fs.realpath(path.join(fx.dev, ".git")))

      assert.ok(await exists(path.join(res.root, "memory", "active", "mem-aaaaaaaa.md")))
      assert.ok(await exists(path.join(res.root, ".memory-owner.json")), "worktree carries an ownership marker")
      assert.ok(await exists(path.join(res.managedRoot!, "owner.json")), "owner directory carries the manifest")
      assert.equal(await exists(path.join(res.root, "src")), false, "application source is not materialized")
      assert.equal(await exists(path.join(res.root, "README.md")), false, "root files are not materialized")
    })
  })

  it("re-creates the worktree if its directory was removed but the registration remains", async () => {
    await withFixture(async (fx) => {
      const first = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      await fs.rm(first.root, { recursive: true, force: true })
      const again = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.equal(again.status, "managed")
      assert.equal(again.root, first.root)
      assert.ok(await exists(path.join(again.root, "memory", "active", "mem-aaaaaaaa.md")))
    })
  })

  it("gives two linked developer worktrees one managed store", async () => {
    await withFixture(async (fx) => {
      const linked = path.join(fx.root, "dev-linked")
      await defaultGitRun(["worktree", "add", "-q", "-b", "linked", linked], fx.dev)
      resetProjectStoreCache()

      const fromMain = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      const fromLinked = await resolveProjectStore(linked, { home: fx.home, forceRefresh: true })

      assert.equal(fromMain.status, "managed")
      assert.equal(fromLinked.status, "managed")
      assert.equal(fromLinked.root, fromMain.root)
      assert.equal(fromLinked.commonDir, fromMain.commonDir)
      assert.notEqual(fromLinked.repository, fromMain.repository)
    })
  })

  it("resolves the repository toplevel from a subdirectory", async () => {
    await withFixture(async (fx) => {
      const fromRoot = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      const nested = path.join(fx.dev, "src", "nested")
      await fs.mkdir(nested, { recursive: true })
      const fromSubdir = await resolveProjectStore(nested, { home: fx.home, forceRefresh: true })
      assert.equal(fromSubdir.status, "managed")
      assert.equal(fromSubdir.root, fromRoot.root)
      assert.equal(fromSubdir.repository, fromRoot.repository)
    })
  })

  it("never changes the developer checkout's HEAD, index, worktree bytes or status", async () => {
    await withFixture(async (fx) => {
      // Staged, unstaged and untracked changes in the developer checkout.
      await fs.writeFile(path.join(fx.dev, "README.md"), "unstaged edit\n", "utf8")
      await fs.writeFile(path.join(fx.dev, "staged.txt"), "staged\n", "utf8")
      await defaultGitRun(["add", "staged.txt"], fx.dev)
      await fs.writeFile(path.join(fx.dev, "untracked.txt"), "untracked\n", "utf8")

      const before = await checkoutState(fx.dev)
      const first = await resolveProjectStore(fx.dev, { home: fx.home, refreshIntervalMs: 0 })
      assert.equal(first.status, "managed")
      const second = await resolveProjectStore(fx.dev, { home: fx.home, refreshIntervalMs: 0 })
      assert.equal(second.root, first.root)
      const after = await checkoutState(fx.dev)

      assert.deepEqual(after, before)
    })
  })
})

// ─── Shared cross-process lease ────────────────────────────────────────────

describe("shared access lease", () => {
  it("does not let a reader observe a paused refresh", async () => {
    await withFixture(async (fx) => {
      const first = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.equal(first.status, "managed")
      const access = accessFor(first)
      await publishRemoteMemory(fx, "mem-bbbbbbbb", "During pause")
      const target = await defaultGitRun(["rev-parse", "origin/main"], fx.dev)

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

      const refreshing = resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true, git: paused })
      await started

      let observed = "not-read"
      const reader = withProjectStoreAccess(access, async () => {
        observed = await fs
          .readFile(path.join(first.root, "memory", "active", "mem-bbbbbbbb.md"), "utf8")
          .catch(() => "missing")
      })

      // The refresh holds the lease while its reset is paused: the reader must
      // not run yet.
      await new Promise((resolve) => setTimeout(resolve, 80))
      assert.equal(observed, "not-read")

      release()
      const [refreshed] = await Promise.all([refreshing, reader])
      assert.equal(refreshed.status, "managed")
      assert.match(observed, /During pause/)
    })
  })

  it("fails consumers closed while an incomplete-refresh marker exists", async () => {
    await withFixture(async (fx) => {
      const first = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      await writeRefreshMarker(fx, first, null, "0".repeat(40))
      let ran = false
      await assert.rejects(
        withStoreAccess({ scope: "project", root: first.root, access: accessFor(first) }, async () => {
          ran = true
        }),
        StoreAccessError,
      )
      assert.equal(ran, false)
    })
  })
})

// ─── Refresh ────────────────────────────────────────────────────────────────

describe("resolveProjectStore: refresh", () => {
  it("makes new default-branch memories visible and preserves staging and audit state", async () => {
    await withFixture(async (fx) => {
      const first = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.equal(first.status, "managed")

      const staged = path.join(first.root, ".memory", "staging", "mem-staged01.md")
      await fs.mkdir(path.dirname(staged), { recursive: true })
      const stagedText = memoryText("mem-staged01", "Pending proposal")
      await fs.writeFile(staged, stagedText, "utf8")
      const auditState = path.join(first.root, ".memory", "audit-state.json")
      await fs.writeFile(auditState, JSON.stringify({ lastHash: "abc", lastAuditAt: "2026-01-01" }), "utf8")

      await publishRemoteMemory(fx, "mem-bbbbbbbb", "New remote memory")
      const second = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })

      assert.equal(second.root, first.root)
      assert.ok(await exists(path.join(second.root, "memory", "active", "mem-bbbbbbbb.md")))
      assert.equal(await fs.readFile(staged, "utf8"), stagedText)
      assert.equal(await fs.readFile(auditState, "utf8"), JSON.stringify({ lastHash: "abc", lastAuditAt: "2026-01-01" }))
    })
  })

  it("serves the cached root inside the refresh interval and refreshes when forced", async () => {
    await withFixture(async (fx) => {
      const first = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      await publishRemoteMemory(fx, "mem-cccccccc", "Cached until forced")

      const cached = await resolveProjectStore(fx.dev, { home: fx.home, refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS })
      assert.equal(cached.root, first.root)
      assert.equal(await exists(path.join(cached.root, "memory", "active", "mem-cccccccc.md")), false)

      const forced = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.ok(await exists(path.join(forced.root, "memory", "active", "mem-cccccccc.md")))
    })
  })

  it("follows the remote's newly advertised default branch, not a stale local origin/HEAD", async () => {
    await withFixture(async (fx) => {
      const first = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.ok(await exists(path.join(first.root, "memory", "active", "mem-aaaaaaaa.md")))

      // The developer moves the remote's default branch to `develop`, which
      // removes the old memory and adds a new one. The local origin/HEAD stays
      // pointed at main (the usual stale state after a clone).
      await defaultGitRun(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], fx.dev)
      await defaultGitRun(["checkout", "-q", "-b", "develop"], fx.dev)
      await fs.rm(path.join(fx.dev, "memory", "active", "mem-aaaaaaaa.md"))
      await fs.writeFile(path.join(fx.dev, "memory", "active", "mem-dddddddd.md"), memoryText("mem-dddddddd", "Develop-only memory"), "utf8")
      await defaultGitRun(["add", "-A"], fx.dev)
      await defaultGitRun(["commit", "-qm", "develop memory"], fx.dev)
      await defaultGitRun(["push", "-q", "origin", "develop"], fx.dev)
      await defaultGitRun(["symbolic-ref", "HEAD", "refs/heads/develop"], fx.remote)

      const refreshed = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.equal(refreshed.status, "managed")
      assert.ok(await exists(path.join(refreshed.root, "memory", "active", "mem-dddddddd.md")))
      assert.equal(await exists(path.join(refreshed.root, "memory", "active", "mem-aaaaaaaa.md")), false)
      assert.equal(
        await defaultGitRun(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], fx.dev),
        "origin/main",
        "the local pointer stayed stale, so the remote lookup had to win",
      )
    })
  })

  it("persists refreshedAt on every successful refresh", async () => {
    await withFixture(async (fx) => {
      const first = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      const manifestFile = path.join(first.managedRoot!, "owner.json")
      const before = JSON.parse(await fs.readFile(manifestFile, "utf8"))
      await new Promise((resolve) => setTimeout(resolve, 15))
      await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      const after = JSON.parse(await fs.readFile(manifestFile, "utf8"))
      assert.equal(typeof before.refreshedAt, "string")
      assert.equal(typeof after.refreshedAt, "string")
      assert.notEqual(after.refreshedAt, before.refreshedAt)
    })
  })

  it("rolls back to the last verified commit when the new target cannot be applied", async () => {
    await withFixture(async (fx) => {
      const first = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.equal(first.status, "managed")
      await publishRemoteMemory(fx, "mem-bbbbbbbb", "New remote memory")

      const previous = await defaultGitRun(["rev-parse", "HEAD"], first.root)
      const target = await defaultGitRun(["rev-parse", "origin/main"], fx.dev)
      assert.notEqual(previous, target)

      const failing: GitRun = async (args, cwd) => {
        if (args[0] === "reset" && args[2] === target) throw new Error("simulated refresh failure")
        return defaultGitRun(args, cwd)
      }
      const refreshed = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true, git: failing })

      assert.equal(refreshed.status, "managed")
      assert.equal(refreshed.root, first.root)
      assert.match(refreshed.detail ?? "", /rolled back/)
      // The previous commit is intact; the failed target's file is not exposed.
      assert.ok(await exists(path.join(refreshed.root, "memory", "active", "mem-aaaaaaaa.md")))
      assert.equal(await exists(path.join(refreshed.root, "memory", "active", "mem-bbbbbbbb.md")), false)
      assert.equal(await exists(path.join(refreshed.managedRoot!, "refresh.json")), false)
    })
  })
})

// ─── Crash-safe refresh transaction ────────────────────────────────────────

describe("incomplete refresh recovery", () => {
  it("restores a deleted tracked memory from the target and clears the marker, bypassing the cache", async () => {
    await withFixture(async (fx) => {
      const first = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.equal(first.status, "managed")
      const head = await defaultGitRun(["rev-parse", "HEAD"], first.root)
      const tracked = path.join(first.root, "memory", "active", "mem-aaaaaaaa.md")
      await fs.rm(tracked)
      const marker = await writeRefreshMarker(fx, first, head, head)

      // No forceRefresh: the marker must outrank the cached managed result.
      const recovered = await resolveProjectStore(fx.dev, { home: fx.home })
      assert.equal(recovered.status, "managed")
      assert.ok(await exists(tracked))
      assert.equal(await exists(marker), false)
    })
  })

  it("keeps the marker and stays unavailable when neither target nor previous verifies", async () => {
    await withFixture(async (fx) => {
      const first = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      const marker = await writeRefreshMarker(fx, first, "a".repeat(40), "b".repeat(40))

      const res = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.equal(res.status, "unavailable")
      assert.equal(await exists(marker), true)
    })
  })
})

// ─── Ownership boundary exploits ───────────────────────────────────────────

describe("ownership boundary", () => {
  it("refuses a managed worktree replaced by a symlink to the developer checkout", async () => {
    await withFixture(async (fx) => {
      const first = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.equal(first.status, "managed")
      await fs.rm(first.root, { recursive: true, force: true })
      await fs.symlink(fx.dev, first.root)
      const before = await checkoutState(fx.dev)

      const res = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.equal(res.status, "unavailable")
      assert.equal(res.problem, "unproven")
      assert.ok((await fs.lstat(first.root)).isSymbolicLink())
      assert.deepEqual(await checkoutState(fx.dev), before)
    })
  })

  it("refuses a swapped symlink for an already-resolved consumer", async () => {
    await withFixture(async (fx) => {
      const first = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      const store = { scope: "project" as const, root: first.root, access: accessFor(first) }
      await fs.rm(first.root, { recursive: true, force: true })
      await fs.symlink(fx.dev, first.root)
      const before = await checkoutState(fx.dev)

      let ran = false
      await assert.rejects(
        withStoreAccess(store, async () => {
          ran = true
        }),
        StoreAccessError,
      )
      assert.equal(ran, false)
      assert.deepEqual(await checkoutState(fx.dev), before)
    })
  })

  it("refuses a substituted worktree marker before any reset", async () => {
    await withFixture(async (fx) => {
      const first = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.equal(first.status, "managed")
      const tracked = path.join(first.root, "memory", "active", "mem-aaaaaaaa.md")
      await fs.appendFile(tracked, "\nlocal edit\n", "utf8")

      const markerFile = path.join(first.root, WORKTREE_MARKER)
      const substituted = JSON.stringify(
        {
          owner: "opencode-plugin-memory",
          version: 1,
          repository: "/somewhere/else/.git",
          worktree: first.root,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )
      await fs.writeFile(markerFile, substituted, "utf8")
      const beforeDev = await checkoutState(fx.dev)

      const res = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.equal(res.status, "unavailable")
      assert.equal(res.problem, "unproven")
      assert.match(await fs.readFile(tracked, "utf8"), /local edit/)
      assert.equal(await fs.readFile(markerFile, "utf8"), substituted)
      assert.deepEqual(await checkoutState(fx.dev), beforeDev)
    })
  })
})

// ─── Failures and ownership ────────────────────────────────────────────────

describe("resolveProjectStore: initialization failure", () => {
  it("fails closed instead of using the developer checkout", async () => {
    await withFixture(async (fx) => {
      const failing = failOn(
        (args) => args[0] === "worktree" && args[1] === "add",
        "simulated worktree failure",
      )
      const before = await checkoutState(fx.dev)
      const res = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true, git: failing })

      assert.equal(res.status, "unavailable")
      assert.equal(res.problem, "unavailable")
      assert.notEqual(res.root, fx.dev)
      assert.ok(res.root.startsWith(fx.base + path.sep))
      assert.deepEqual(await checkoutState(fx.dev), before)
    })
  })

  it("fails closed when Git cannot report a directory that is inside a repository", async () => {
    await withFixture(async (fx) => {
      const broken: GitRun = async () => {
        throw new Error("git is unavailable")
      }
      const res = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true, git: broken })
      assert.equal(res.status, "unavailable")
      assert.notEqual(res.root, fx.dev)
      assert.ok(res.root.startsWith(fx.base + path.sep))
    })
  })

  it("refuses runtime state without a worktree ownership marker, leaving it untouched", async () => {
    await withFixture(async (fx) => {
      const failing = failOn((args) => args[0] === "worktree" && args[1] === "add", "simulated worktree failure")
      const failed = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true, git: failing })
      assert.equal(failed.status, "unavailable")

      await fs.mkdir(path.join(failed.root, ".memory", "staging"), { recursive: true })
      const staged = path.join(failed.root, ".memory", "staging", "mem-staged01.md")
      await fs.writeFile(staged, "pending\n", "utf8")

      const res = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.equal(res.status, "unavailable")
      assert.equal(res.problem, "unproven")
      assert.equal(await fs.readFile(staged, "utf8"), "pending\n")
      assert.equal(await exists(path.join(failed.root, WORKTREE_MARKER)), false)
    })
  })

  it("refuses a mismatched worktree marker without modifying marker or state", async () => {
    await withFixture(async (fx) => {
      const crafted = await craftOwnerStore(fx, "/somewhere/else/.git")
      const res = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.equal(res.status, "unavailable")
      assert.equal(res.problem, "unproven")
      assert.equal(await fs.readFile(crafted.markerFile, "utf8"), crafted.markerText)
      assert.equal(await fs.readFile(crafted.stagingFile, "utf8"), "pending\n")
      assert.equal(await exists(path.join(crafted.paths.worktree, "memory")), false)
    })
  })

  it("recovers runtime state when both owner manifest and worktree marker match", async () => {
    await withFixture(async (fx) => {
      const identity = await fs.realpath(path.join(fx.dev, ".git"))
      const crafted = await craftOwnerStore(fx, identity)
      const recovered = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.equal(recovered.status, "managed")
      assert.equal(recovered.root, crafted.paths.worktree)
      assert.equal(await fs.readFile(crafted.stagingFile, "utf8"), "pending\n")
      const marker = JSON.parse(await fs.readFile(path.join(recovered.root, WORKTREE_MARKER), "utf8"))
      assert.equal(marker.repository, identity)
    })
  })

  it("refuses an owner directory it cannot prove is its own", async () => {
    await withFixture(async (fx) => {
      const identity = await fs.realpath(path.join(fx.dev, ".git"))
      const paths = managedPaths(identity, fx.base)
      await fs.mkdir(paths.ownerDir, { recursive: true })
      const canary = path.join(paths.ownerDir, "canary.txt")
      await fs.writeFile(canary, "not yours\n", "utf8")

      const res = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.equal(res.status, "unavailable")
      assert.equal(res.problem, "unproven")
      assert.equal(await fs.readFile(canary, "utf8"), "not yours\n")
      assert.equal(await exists(paths.worktree), false)
    })
  })
})

// ─── Refresh lock ownership ────────────────────────────────────────────────

describe("lockIsStale", () => {
  it("never expires a live owner by age", () => {
    // Timestamp 0 is as old as possible; the owner is alive, so it keeps the lock.
    assert.equal(lockIsStale("123:0", () => true), false)
  })

  it("treats a dead owner or malformed lock as stale", () => {
    assert.equal(lockIsStale("123:0", () => false), true)
    assert.equal(lockIsStale("not-a-lock", () => true), true)
    assert.equal(lockIsStale("0:123", () => true), true)
    assert.equal(lockIsStale("123:not-a-time", () => true), true)
  })
})

// ─── One-time runtime-state migration ──────────────────────────────────────

describe("resolveProjectStore: legacy runtime state", () => {
  it("copies staging and audit state from the checkout once, excluding lock files", async () => {
    await withFixture(async (fx) => {
      const oldMachine = path.join(fx.dev, ".memory")
      await fs.mkdir(path.join(oldMachine, "staging"), { recursive: true })
      await fs.writeFile(path.join(oldMachine, "staging", "mem-old00001.md"), memoryText("mem-old00001", "Old staged"), "utf8")
      await fs.writeFile(path.join(oldMachine, "audit-state.json"), JSON.stringify({ lastHash: "old" }), "utf8")
      await fs.writeFile(path.join(oldMachine, "bot.lock"), "123:456", "utf8")

      const first = await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.equal(first.status, "managed")
      assert.ok(await exists(path.join(first.root, ".memory", "staging", "mem-old00001.md")))
      assert.equal(await fs.readFile(path.join(first.root, ".memory", "audit-state.json"), "utf8"), JSON.stringify({ lastHash: "old" }))
      assert.equal(await exists(path.join(first.root, ".memory", "bot.lock")), false)

      // A later file in the checkout must not be copied again (one-time).
      await fs.writeFile(path.join(oldMachine, "staging", "mem-old00002.md"), memoryText("mem-old00002", "Later staged"), "utf8")
      await resolveProjectStore(fx.dev, { home: fx.home, forceRefresh: true })
      assert.equal(await exists(path.join(first.root, ".memory", "staging", "mem-old00002.md")), false)
    })
  })
})
