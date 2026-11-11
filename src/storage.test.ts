import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  activeDir,
  generateMemoryId,
  isMemoryId,
  listActiveMemories,
  listRetiredMemories,
  listStagedProposals,
  memoryAge,
  moveToActive,
  moveToRetired,
  readMemoryById,
  readMemoryFile,
  resolveAuthor,
  retiredDir,
  stagingDir,
  writeMemoryFile,
  writeProposal,
  StoreWriteError,
} from "./storage.js"
import type { Memory } from "./types.js"

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-store-"))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function activeMemory(id: string, title: string, body = "content"): Memory {
  return { id, title, body, approvedAt: "2026-01-01", proposedAt: "2026-01-01" }
}

// ─── identity ───────────────────────────────────────────────────────────────

describe("generateMemoryId", () => {
  it("produces mem- + 8 base64url chars and is collision-free in practice", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const id = generateMemoryId()
      assert.match(id, /^mem-[A-Za-z0-9_-]{8}$/)
      assert.ok(isMemoryId(id))
      assert.ok(!seen.has(id))
      seen.add(id)
    }
  })
})

describe("isMemoryId", () => {
  it("accepts well-formed ids and rejects others", () => {
    assert.equal(isMemoryId("mem-aaaaaaaa"), true)
    assert.equal(isMemoryId("mem-A_b-c123"), true)
    assert.equal(isMemoryId("mem-aaa"), false)
    assert.equal(isMemoryId("MEM-001"), false)
    assert.equal(isMemoryId("mem-aaaaaaa!"), false)
    assert.equal(isMemoryId(""), false)
  })
})

// ─── author ─────────────────────────────────────────────────────────────────

describe("resolveAuthor", () => {
  it("uses user.name first", async () => {
    const author = await resolveAuthor("/proj", async (key) => (key === "user.name" ? "Alice" : null))
    assert.equal(author, "Alice")
  })

  it("falls back to user.email when there is no name", async () => {
    const author = await resolveAuthor("/proj", async (key) => (key === "user.email" ? "alice@example.com" : null))
    assert.equal(author, "alice@example.com")
  })

  it("falls back to unknown on any failure", async () => {
    assert.equal(await resolveAuthor("/proj", async () => null), "unknown")
    assert.equal(await resolveAuthor("/proj", async () => ""), "unknown")
  })
})

// ─── propose / stage ────────────────────────────────────────────────────────

describe("writeProposal and staging", () => {
  it("writes a proposal file to .memory/staging and lists it back", async () => {
    await withDir(async (dir) => {
      const memory: Memory = {
        id: "mem-aaaaaaaa",
        title: "Rule",
        body: "The rule body.",
        author: "alice",
        proposedAt: "2026-01-01T00:00:00.000Z",
        intent: "propose",
      }
      await writeProposal(dir, memory)
      const staged = await listStagedProposals(dir)
      assert.equal(staged.length, 1)
      assert.equal(staged[0]!.id, "mem-aaaaaaaa")
      assert.equal(staged[0]!.body, "The rule body.")
      assert.equal(staged[0]!.intent, "propose")

      const byId = await readMemoryById(dir, "mem-aaaaaaaa")
      assert.equal(byId!.status, "staging")
      assert.equal(byId!.memory.title, "Rule")
    })
  })

  it("does not appear in active or retired lists", async () => {
    await withDir(async (dir) => {
      await writeProposal(dir, { id: "mem-aaaaaaaa", title: "Rule", body: "b", intent: "propose" })
      assert.equal((await listActiveMemories(dir)).length, 0)
      assert.equal((await listRetiredMemories(dir)).length, 0)
    })
  })

  it("throws a clean StoreWriteError when staging is not writable", async () => {
    const file = path.join(os.tmpdir(), `mem-notdir-${process.pid}`)
    await fs.writeFile(file, "x", "utf8")
    try {
      await assert.rejects(
        writeProposal(file, { id: "mem-aaaaaaaa", title: "T", body: "b", intent: "propose" }),
        (err: unknown) => err instanceof StoreWriteError && /not writable/.test((err as Error).message),
      )
    } finally {
      await fs.rm(file, { force: true })
    }
  })
})

// ─── read active / retired ──────────────────────────────────────────────────

describe("active and retired reads", () => {
  it("lists active memories and reads one by id", async () => {
    await withDir(async (dir) => {
      await writeMemoryFile(activeDir(dir), activeMemory("mem-aaaaaaaa", "First"))
      await writeMemoryFile(activeDir(dir), activeMemory("mem-bbbbbbbb", "Second"))
      const active = await listActiveMemories(dir)
      assert.equal(active.length, 2)
      const byId = await readMemoryById(dir, "mem-aaaaaaaa")
      assert.equal(byId!.status, "active")
      assert.equal(byId!.memory.title, "First")
    })
  })

  it("lists retired memories and reads one by id", async () => {
    await withDir(async (dir) => {
      const retired: Memory = {
        id: "mem-cccccccc",
        title: "Old",
        body: "old body",
        retiredAt: "2026-02-01",
        retiredReason: "stale",
      }
      await writeMemoryFile(retiredDir(dir), retired)
      const list = await listRetiredMemories(dir)
      assert.equal(list.length, 1)
      assert.equal(list[0]!.retiredReason, "stale")
      assert.equal((await readMemoryById(dir, "mem-cccccccc"))!.status, "retired")
    })
  })

  it("skips files with malformed frontmatter", async () => {
    await withDir(async (dir) => {
      await writeMemoryFile(activeDir(dir), activeMemory("mem-aaaaaaaa", "Good"))
      await fs.writeFile(path.join(activeDir(dir), "mem-bbbbbbbb.md"), "no frontmatter here", "utf8")
      await fs.writeFile(path.join(activeDir(dir), "mem-cccccccc.md"), "---\ntitle: missing id\n---\nbody", "utf8")
      const active = await listActiveMemories(dir)
      assert.equal(active.length, 1)
      assert.equal(active[0]!.id, "mem-aaaaaaaa")
    })
  })

  it("readMemoryFile returns null for a missing file", async () => {
    await withDir(async (dir) => {
      assert.equal(await readMemoryFile(path.join(activeDir(dir), "mem-aaaaaaaa.md")), null)
    })
  })
})

// ─── moves ──────────────────────────────────────────────────────────────────

describe("move helpers", () => {
  it("moveToRetired moves an active memory to retired/", async () => {
    await withDir(async (dir) => {
      await writeMemoryFile(activeDir(dir), activeMemory("mem-aaaaaaaa", "X"))
      await moveToRetired(dir, "mem-aaaaaaaa")
      assert.equal((await listActiveMemories(dir)).length, 0)
      assert.equal((await listRetiredMemories(dir)).length, 1)
    })
  })

  it("moveToActive moves a retired memory back to active/", async () => {
    await withDir(async (dir) => {
      await writeMemoryFile(retiredDir(dir), { id: "mem-aaaaaaaa", title: "X", body: "b", retiredReason: "stale" })
      await moveToActive(dir, "mem-aaaaaaaa")
      assert.equal((await listRetiredMemories(dir)).length, 0)
      assert.equal((await listActiveMemories(dir)).length, 1)
    })
  })
})

// ─── aging ──────────────────────────────────────────────────────────────────

describe("memoryAge", () => {
  const now = new Date("2026-01-01T00:00:00Z")
  it("measures whole days from approved_at, falling back to proposed_at", () => {
    assert.equal(memoryAge({ id: "mem-aaaaaaaa", title: "T", body: "", approvedAt: "2025-12-01", proposedAt: "2025-11-01" }, now), 31)
    assert.equal(memoryAge({ id: "mem-aaaaaaaa", title: "T", body: "", proposedAt: "2025-12-01" }, now), 31)
  })
  it("returns NaN when there is no usable timestamp", () => {
    assert.ok(Number.isNaN(memoryAge({ id: "mem-aaaaaaaa", title: "T", body: "" }, now)))
    assert.ok(Number.isNaN(memoryAge({ id: "mem-aaaaaaaa", title: "T", body: "", proposedAt: "not-a-date" }, now)))
  })
})

// ─── paths ──────────────────────────────────────────────────────────────────

describe("path helpers", () => {
  it("resolve under the project root", () => {
    assert.equal(stagingDir("/p"), path.join("/p", ".memory/staging"))
    assert.equal(activeDir("/p"), path.join("/p", "memory/active"))
    assert.equal(retiredDir("/p"), path.join("/p", "memory/retired"))
  })
})
