import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { applyPropose, applyRetire, buildPrBody, buildPrTitle, defaultBranch } from "./bot.js"
import { activeDir, listActiveMemories, listRetiredMemories, retiredDir, stagingDir, writeMemoryFile, writeProposal } from "./storage.js"
import type { Memory } from "./types.js"

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-bot-"))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function active(id: string, title: string, body = "content"): Memory {
  return { id, title, body, proposedAt: "2026-01-01", approvedAt: "2026-01-01" }
}

describe("applyPropose", () => {
  it("promotes a proposal into active/ and strips the intent field", async () => {
    await withDir(async (dir) => {
      const proposal: Memory = {
        id: "mem-aaaa0001",
        title: "New rule",
        body: "The body.",
        author: "alice",
        proposedAt: "2026-01-01",
        intent: "propose",
      }
      await applyPropose(dir, proposal)

      const activeMemories = await listActiveMemories(dir)
      assert.equal(activeMemories.length, 1)
      assert.equal(activeMemories[0]!.id, "mem-aaaa0001")
      assert.equal(activeMemories[0]!.body, "The body.")
      assert.equal(activeMemories[0]!.intent, undefined)
    })
  })

  it("moves superseded targets to retired/ with superseded_by links", async () => {
    await withDir(async (dir) => {
      await writeMemoryFile(activeDir(dir), active("mem-old00001", "Old rule"))
      const proposal: Memory = {
        id: "mem-new00002",
        title: "New rule",
        body: "b",
        supersedes: ["mem-old00001"],
        intent: "propose",
      }
      await applyPropose(dir, proposal)

      assert.equal((await listActiveMemories(dir)).length, 1)
      const retired = await listRetiredMemories(dir)
      assert.equal(retired.length, 1)
      assert.equal(retired[0]!.id, "mem-old00001")
      assert.equal(retired[0]!.supersededBy, "mem-new00002")
      assert.equal(retired[0]!.retiredReason, "superseded")
      assert.ok(retired[0]!.retiredAt)
    })
  })

  it("is idempotent — re-running does not duplicate retired files", async () => {
    await withDir(async (dir) => {
      await writeMemoryFile(activeDir(dir), active("mem-old00001", "Old"))
      const proposal: Memory = { id: "mem-new00002", title: "New", body: "b", supersedes: ["mem-old00001"], intent: "propose" }
      await applyPropose(dir, proposal)
      await applyPropose(dir, proposal)

      assert.equal((await listActiveMemories(dir)).length, 1)
      assert.equal((await listRetiredMemories(dir)).length, 1)
    })
  })

  it("does not remove the staged file (orchestration does that)", async () => {
    await withDir(async (dir) => {
      const proposal: Memory = { id: "mem-aaaa0001", title: "T", body: "b", intent: "propose" }
      await writeProposal(dir, proposal)
      await applyPropose(dir, proposal)
      await fs.access(path.join(stagingDir(dir), "mem-aaaa0001.md"))
    })
  })
})

describe("applyRetire", () => {
  it("moves an active memory to retired/ with the reason", async () => {
    await withDir(async (dir) => {
      await writeMemoryFile(activeDir(dir), active("mem-aaaa0001", "To remove"))
      const staged: Memory = { id: "mem-aaaa0001", title: "To remove", body: "", intent: "retire", retiredReason: "wrong" }
      await applyRetire(dir, staged)

      assert.equal((await listActiveMemories(dir)).length, 0)
      const retired = await listRetiredMemories(dir)
      assert.equal(retired.length, 1)
      assert.equal(retired[0]!.retiredReason, "wrong")
      assert.ok(retired[0]!.retiredAt)
    })
  })

  it("is a no-op when the active memory is already gone", async () => {
    await withDir(async (dir) => {
      const staged: Memory = { id: "mem-aaaa0001", title: "Gone", body: "", intent: "retire", retiredReason: "stale" }
      const changed = await applyRetire(dir, staged)
      assert.deepEqual(changed, [])
      assert.equal((await listRetiredMemories(dir)).length, 0)
    })
  })
})

describe("PR template", () => {
  it("titles a propose and a retire distinctly", () => {
    assert.equal(buildPrTitle({ id: "mem-aaaa0001", title: "Use int for money", body: "", intent: "propose" }), "memory: Use int for money")
    assert.equal(buildPrTitle({ id: "mem-aaaa0001", title: "X", body: "", intent: "retire" }), "memory: retire mem-aaaa0001")
  })

  it("body lists the checklist and retire reason", () => {
    const body = buildPrBody({ id: "mem-aaaa0001", title: "X", body: "", intent: "retire", retiredReason: "stale" })
    assert.match(body, /retire \(reason: stale\)/)
    assert.match(body, /memory checklist/)
    assert.match(body, /Not a duplicate/)
  })
})

describe("defaultBranch", () => {
  it("returns main when not in a repo", async () => {
    await withDir(async (dir) => {
      assert.equal(await defaultBranch(dir), "main")
    })
  })
})
