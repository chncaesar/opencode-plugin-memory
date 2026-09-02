import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildSystemPrompt, buildSummary } from "./summary.js"
import type { MemoryStore } from "./types.js"

function emptyStore(): MemoryStore {
  return { entries: [], nextSeq: 1 }
}

// ─── buildSystemPrompt ──────────────────────────────────────────────────────

describe("buildSystemPrompt", () => {
  it("injects a memory-system instruction even when the store is empty", () => {
    const out = buildSystemPrompt(emptyStore(), 2000)
    assert.match(out, /persistent, project-scoped memory system/)
    assert.match(out, /memory_add/)
    assert.match(out, /No memories are stored/)
    assert.match(out, /remember this/)
  })

  it("does not claim entries exist when the store is empty", () => {
    const out = buildSystemPrompt(emptyStore(), 2000)
    assert.doesNotMatch(out, /MEM-\d+/)
  })

  it("appends a maintain nudge when memories exist", () => {
    const store: MemoryStore = {
      entries: [
        {
          id: "MEM-001",
          title: "Always int for money",
          content: "Use cents.",
          added: "2026-08-26",
          archived: false,
        },
      ],
      nextSeq: 2,
    }
    const out = buildSystemPrompt(store, 2000)
    assert.match(out, /MEM-001/)
    assert.match(out, /Maintain this memory: call memory_add/)
  })

  it("ignores archived entries when deciding empty vs non-empty", () => {
    const store: MemoryStore = {
      entries: [
        {
          id: "MEM-001",
          title: "Old entry",
          content: "archived",
          added: "2026-08-20",
          archived: true,
        },
      ],
      nextSeq: 2,
    }
    const out = buildSystemPrompt(store, 2000)
    assert.match(out, /No memories are stored/)
    assert.doesNotMatch(out, /Old entry/)
  })
})

// ─── buildSummary ───────────────────────────────────────────────────────────

describe("buildSummary", () => {
  it("lists active entries newest-first", () => {
    const store: MemoryStore = {
      entries: [
        { id: "MEM-001", title: "Old", content: "", added: "2026-08-01", archived: false },
        { id: "MEM-002", title: "New", content: "", added: "2026-08-30", archived: false },
      ],
      nextSeq: 3,
    }
    const out = buildSummary(store, 2000)
    const newIdx = out.indexOf("MEM-002")
    const oldIdx = out.indexOf("MEM-001")
    assert.ok(newIdx >= 0 && oldIdx >= 0)
    assert.ok(newIdx < oldIdx, "newest entry should come first")
  })

  it("excludes archived entries", () => {
    const store: MemoryStore = {
      entries: [
        { id: "MEM-001", title: "Active", content: "", added: "2026-08-26", archived: false },
        { id: "MEM-002", title: "Archived", content: "", added: "2026-08-20", archived: true },
      ],
      nextSeq: 3,
    }
    const out = buildSummary(store, 2000)
    assert.match(out, /MEM-001/)
    assert.doesNotMatch(out, /MEM-002/)
  })

  it("truncates to maxChars", () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      id: `MEM-${String(i + 1).padStart(3, "0")}`,
      title: `A very long title number ${i + 1} with extra words`,
      content: "",
      added: "2026-08-26",
      archived: false,
    }))
    const store: MemoryStore = { entries, nextSeq: 51 }
    const out = buildSummary(store, 500)
    assert.ok(out.length <= 500 + 100, `summary too long: ${out.length}`)
    assert.match(out, /truncated/)
  })
})
