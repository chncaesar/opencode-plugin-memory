import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { buildIndexLines, buildSystemPrompt, loadMemoryBlock } from "./summary.js"
import { MEMORY_POLICY_EXAMPLES, MEMORY_WRITE_POLICY } from "./prompt.js"
import { activeDir, writeMemoryFile } from "./storage.js"
import type { Memory } from "./types.js"

function mem(id: string, title: string): Memory {
  return { id, title, body: "c", proposedAt: "2026-01-01" }
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-summary-"))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe("buildIndexLines", () => {
  it("emits one line per memory, sorted by id", () => {
    const lines = buildIndexLines([mem("mem-bbbbbbbb", "B"), mem("mem-aaaaaaaa", "A")])
    assert.deepEqual(lines, ["[mem-aaaaaaaa] A", "[mem-bbbbbbbb] B"])
  })

  it("carries titles only, never bodies", () => {
    const lines = buildIndexLines([{ ...mem("mem-aaaaaaaa", "Title"), body: "secret body text" }])
    assert.deepEqual(lines, ["[mem-aaaaaaaa] Title"])
  })
})

describe("loadMemoryBlock", () => {
  it("derives the index from memory/active and writes nothing", async () => {
    await withDir(async (dir) => {
      await writeMemoryFile(activeDir(dir), mem("mem-aaaaaaaa", "First rule"))
      const block = await loadMemoryBlock(dir, 2000)
      assert.match(block, /\[mem-aaaaaaaa\] First rule/)
      // No index file is created or expected.
      await assert.rejects(fs.access(path.join(dir, "memory", "_summary.md")))
    })
  })

  it("renders an empty store without creating the memory folder", async () => {
    await withDir(async (dir) => {
      const block = await loadMemoryBlock(dir, 2000)
      assert.match(block, /no active memories/)
      await assert.rejects(fs.access(path.join(dir, "memory")))
    })
  })
})

describe("buildSystemPrompt", () => {
  it("injects the intro and policy, and no index lines when empty", () => {
    const out = buildSystemPrompt([], 2000)
    assert.match(out, /PR-gated project memory system/)
    assert.match(out, /no active memories/)
    assert.ok(out.includes(MEMORY_WRITE_POLICY))
  })

  it("injects the index lines and never full bodies", () => {
    const out = buildSystemPrompt([{ ...mem("mem-aaaaaaaa", "First rule"), body: "very long body" }], 2000)
    assert.match(out, /\[mem-aaaaaaaa\] First rule/)
    assert.ok(out.includes(MEMORY_WRITE_POLICY))
    assert.ok(!out.includes("very long body"))
  })

  it("truncates a long index to maxChars with a notice", () => {
    const many = Array.from({ length: 40 }, (_, i) => mem(`mem-${String(i).padStart(8, "0")}`, `Title ${i} with some words`))
    const out = buildSystemPrompt(many, 200)
    const indexPart = out.split("Project memory index:")[1]!.split("## When to propose")[0]!
    assert.ok(indexPart.includes("showing a subset"))
    // The index section (titles only) is capped near maxChars; the policy is
    // injected separately and is not part of the truncation budget.
    assert.ok(indexPart.length <= 210)
  })
})

describe("memory-writing policy", () => {
  it("covers corrections, confirmations, temporary limits, and task-local requests", () => {
    for (const signal of ["correction", "confirmation", "temporary", "task-local"] as const) {
      assert.ok(MEMORY_POLICY_EXAMPLES.some((e) => e.signal === signal), `missing ${signal} example`)
    }
  })

  it("teaches the PR gate and the new tool names", () => {
    assert.match(MEMORY_WRITE_POLICY, /PROPOSE/i)
    assert.match(MEMORY_WRITE_POLICY, /memory_propose/)
    assert.match(MEMORY_WRITE_POLICY, /memory_update/)
    assert.match(MEMORY_WRITE_POLICY, /memory_delete/)
    assert.match(MEMORY_WRITE_POLICY, /merge/i)
  })

  it("preserves the granularity and title-coherence rules", () => {
    assert.match(MEMORY_WRITE_POLICY, /Granularity and title-content coherence/)
    assert.match(MEMORY_WRITE_POLICY, /Title must summarize the full content/)
  })

  it("tells the model not to record facts a simple query can answer", () => {
    assert.match(MEMORY_WRITE_POLICY, /Do not record what a simple query can answer/)
    assert.match(MEMORY_WRITE_POLICY, /production migration version/)
    assert.ok(
      MEMORY_POLICY_EXAMPLES.some((e) => e.decision === "skip" && /migration/i.test(e.cue)),
      "missing skip example for query-derivable state",
    )
  })

  it("teaches the model to record the lesson behind a bug fix, not the incident", () => {
    assert.match(MEMORY_WRITE_POLICY, /Bug fixes: record the lesson, not the incident/)
    assert.match(MEMORY_WRITE_POLICY, /Root cause/)
    assert.match(MEMORY_WRITE_POLICY, /Generalize/)
    assert.match(MEMORY_WRITE_POLICY, /actionable rule/)
    assert.ok(
      MEMORY_POLICY_EXAMPLES.some((e) => e.signal === "llm-discovery" && /bug/i.test(e.cue) && /rule/i.test(e.guidance)),
      "missing bug-lesson example",
    )
  })
})

describe("buildSystemPrompt default cap", () => {
  it("fits all 56 realistic titles under the 10000-char default cap", () => {
    const memories = Array.from({ length: 56 }, (_, i) =>
      mem(`mem-${String(i).padStart(8, "0")}`, `${"标题".repeat(40)} ${i}`),
    )
    const out = buildSystemPrompt(memories, 10000)
    for (const m of memories) assert.ok(out.includes(`[${m.id}] ${m.title}`))
    assert.ok(!out.includes("showing a subset"))
  })
})
