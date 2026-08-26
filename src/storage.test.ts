import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  parseMemory,
  serializeMemory,
  addEntry,
  updateEntry,
  archiveEntry,
  searchEntries,
} from "./storage.js"
import type { MemoryStore } from "./types.js"

// ─── parseMemory ─────────────────────────────────────────────────────────────

describe("parseMemory", () => {
  it("returns empty store for blank input", () => {
    const store = parseMemory("")
    assert.equal(store.entries.length, 0)
    assert.equal(store.nextSeq, 1)
  })

  it("parses nextSeq from comment", () => {
    const store = parseMemory("# OpenCode Memory\n<!-- nextSeq: 7 -->\n\n## Active\n")
    assert.equal(store.nextSeq, 7)
  })

  it("parses a single active entry", () => {
    const text = [
      "# OpenCode Memory",
      "<!-- nextSeq: 2 -->",
      "",
      "## Active",
      "",
      "### [MEM-001] Use int for money",
      "- added: 2026-08-26",
      "- tags: coding-style, finance",
      "Always store amounts as int cents.",
      "",
      "## Archived",
      "",
    ].join("\n")

    const store = parseMemory(text)
    assert.equal(store.entries.length, 1)
    const e = store.entries[0]!
    assert.equal(e.id, "MEM-001")
    assert.equal(e.title, "Use int for money")
    assert.equal(e.added, "2026-08-26")
    assert.deepEqual(e.tags, ["coding-style", "finance"])
    assert.equal(e.content, "Always store amounts as int cents.")
    assert.equal(e.archived, false)
  })

  it("parses updated field", () => {
    const text = [
      "# OpenCode Memory",
      "<!-- nextSeq: 2 -->",
      "",
      "## Active",
      "",
      "### [MEM-001] Title",
      "- added: 2026-08-20",
      "- updated: 2026-08-26",
      "Body.",
      "",
      "## Archived",
      "",
    ].join("\n")

    const store = parseMemory(text)
    assert.equal(store.entries[0]!.updated, "2026-08-26")
  })

  it("parses archived entries correctly", () => {
    const text = [
      "# OpenCode Memory",
      "<!-- nextSeq: 3 -->",
      "",
      "## Active",
      "",
      "## Archived",
      "",
      "### [MEM-001] Old thing",
      "- added: 2026-08-01",
      "Content.",
      "",
    ].join("\n")

    const store = parseMemory(text)
    assert.equal(store.entries.length, 1)
    assert.equal(store.entries[0]!.archived, true)
  })

  it("parses multiple entries", () => {
    const text = [
      "# OpenCode Memory",
      "<!-- nextSeq: 3 -->",
      "",
      "## Active",
      "",
      "### [MEM-001] First",
      "- added: 2026-08-01",
      "Content one.",
      "",
      "### [MEM-002] Second",
      "- added: 2026-08-02",
      "Content two.",
      "",
      "## Archived",
      "",
    ].join("\n")

    const store = parseMemory(text)
    assert.equal(store.entries.length, 2)
    assert.equal(store.entries[0]!.id, "MEM-001")
    assert.equal(store.entries[1]!.id, "MEM-002")
  })
})

// ─── serializeMemory ─────────────────────────────────────────────────────────

describe("serializeMemory", () => {
  it("round-trips through parse → serialize → parse", () => {
    const original: MemoryStore = {
      nextSeq: 3,
      entries: [
        {
          id: "MEM-001",
          title: "Use int for money",
          content: "Always int cents.",
          added: "2026-08-20",
          updated: "2026-08-26",
          tags: ["coding-style"],
          archived: false,
        },
        {
          id: "MEM-002",
          title: "Old rule",
          content: "Archived body.",
          added: "2026-08-01",
          archived: true,
        },
      ],
    }

    const serialized = serializeMemory(original)
    const reparsed = parseMemory(serialized)

    assert.equal(reparsed.nextSeq, original.nextSeq)
    assert.equal(reparsed.entries.length, 2)

    const active = reparsed.entries[0]!
    assert.equal(active.id, "MEM-001")
    assert.equal(active.title, "Use int for money")
    assert.equal(active.updated, "2026-08-26")
    assert.deepEqual(active.tags, ["coding-style"])
    assert.equal(active.archived, false)

    const archived = reparsed.entries[1]!
    assert.equal(archived.id, "MEM-002")
    assert.equal(archived.archived, true)
  })

  it("includes nextSeq comment", () => {
    const store: MemoryStore = { nextSeq: 5, entries: [] }
    const text = serializeMemory(store)
    assert.ok(text.includes("<!-- nextSeq: 5 -->"))
  })
})

// ─── addEntry ────────────────────────────────────────────────────────────────

describe("addEntry", () => {
  it("assigns sequential IDs and increments nextSeq", () => {
    let store: MemoryStore = { nextSeq: 1, entries: [] }
    let id: string

    ;({ store, id } = addEntry(store, "First", "body"))
    assert.equal(id, "MEM-001")
    assert.equal(store.nextSeq, 2)

    ;({ store, id } = addEntry(store, "Second", "body"))
    assert.equal(id, "MEM-002")
    assert.equal(store.nextSeq, 3)
  })

  it("pads ID to three digits", () => {
    const store: MemoryStore = { nextSeq: 9, entries: [] }
    const { id } = addEntry(store, "T", "b")
    assert.equal(id, "MEM-009")
  })

  it("stores tags when provided", () => {
    const store: MemoryStore = { nextSeq: 1, entries: [] }
    const { store: next } = addEntry(store, "T", "b", ["tag-a", "tag-b"])
    assert.deepEqual(next.entries[0]!.tags, ["tag-a", "tag-b"])
  })

  it("does not set tags field when tags is empty", () => {
    const store: MemoryStore = { nextSeq: 1, entries: [] }
    const { store: next } = addEntry(store, "T", "b", [])
    assert.equal("tags" in next.entries[0]!, false)
  })

  it("sets archived to false", () => {
    const store: MemoryStore = { nextSeq: 1, entries: [] }
    const { store: next } = addEntry(store, "T", "b")
    assert.equal(next.entries[0]!.archived, false)
  })
})

// ─── updateEntry ─────────────────────────────────────────────────────────────

describe("updateEntry", () => {
  function storeWithOne(): MemoryStore {
    const base: MemoryStore = { nextSeq: 1, entries: [] }
    return addEntry(base, "Original title", "Original content", ["old-tag"]).store
  }

  it("returns null for unknown ID", () => {
    const store = storeWithOne()
    assert.equal(updateEntry(store, "MEM-999", { content: "x" }), null)
  })

  it("updates title only", () => {
    const store = updateEntry(storeWithOne(), "MEM-001", { title: "New title" })!
    assert.equal(store.entries[0]!.title, "New title")
    assert.equal(store.entries[0]!.content, "Original content")
  })

  it("updates content only", () => {
    const store = updateEntry(storeWithOne(), "MEM-001", { content: "New content" })!
    assert.equal(store.entries[0]!.content, "New content")
    assert.equal(store.entries[0]!.title, "Original title")
  })

  it("updates tags", () => {
    const store = updateEntry(storeWithOne(), "MEM-001", { tags: ["new-tag"] })!
    assert.deepEqual(store.entries[0]!.tags, ["new-tag"])
  })

  it("sets updated date", () => {
    const store = updateEntry(storeWithOne(), "MEM-001", { title: "x" })!
    const today = new Date().toISOString().slice(0, 10)
    assert.equal(store.entries[0]!.updated, today)
  })

  it("does not touch archived entries", () => {
    const base = storeWithOne()
    const archived = archiveEntry(base, "MEM-001")!
    const result = updateEntry(archived, "MEM-001", { title: "x" })
    assert.equal(result, null)
  })
})

// ─── archiveEntry ────────────────────────────────────────────────────────────

describe("archiveEntry", () => {
  it("returns null for unknown ID", () => {
    const store: MemoryStore = { nextSeq: 1, entries: [] }
    assert.equal(archiveEntry(store, "MEM-001"), null)
  })

  it("moves entry to archived", () => {
    const base: MemoryStore = { nextSeq: 1, entries: [] }
    const { store } = addEntry(base, "T", "b")
    const next = archiveEntry(store, "MEM-001")!
    assert.equal(next.entries[0]!.archived, true)
  })

  it("does not re-archive an already archived entry", () => {
    const base: MemoryStore = { nextSeq: 1, entries: [] }
    const { store } = addEntry(base, "T", "b")
    const once = archiveEntry(store, "MEM-001")!
    const twice = archiveEntry(once, "MEM-001")
    assert.equal(twice, null)
  })

  it("preserves other entries", () => {
    let store: MemoryStore = { nextSeq: 1, entries: [] }
    ;({ store } = addEntry(store, "A", "a"))
    ;({ store } = addEntry(store, "B", "b"))
    store = archiveEntry(store, "MEM-001")!
    assert.equal(store.entries.length, 2)
    assert.equal(store.entries[1]!.archived, false)
  })
})

// ─── searchEntries ───────────────────────────────────────────────────────────

describe("searchEntries", () => {
  function populated(): MemoryStore {
    let store: MemoryStore = { nextSeq: 1, entries: [] }
    ;({ store } = addEntry(store, "Use int for money", "Store as cents", ["finance"]))
    ;({ store } = addEntry(store, "Git push confirmation", "Always confirm before push", ["workflow"]))
    store = archiveEntry(store, "MEM-002")!
    return store
  }

  it("returns all active when no query", () => {
    const results = searchEntries(populated(), "")
    // MEM-002 is archived, only MEM-001 active
    assert.equal(results.length, 1)
  })

  it("matches title case-insensitively", () => {
    const results = searchEntries(populated(), "INT")
    assert.equal(results.length, 1)
    assert.equal(results[0]!.id, "MEM-001")
  })

  it("matches content", () => {
    const results = searchEntries(populated(), "cents")
    assert.equal(results.length, 1)
  })

  it("matches tags", () => {
    const results = searchEntries(populated(), "finance")
    assert.equal(results.length, 1)
  })

  it("excludes archived entries", () => {
    // MEM-002 is archived and matches "workflow" tag
    const results = searchEntries(populated(), "workflow")
    assert.equal(results.length, 0)
  })

  it("returns empty when no match", () => {
    const results = searchEntries(populated(), "nonexistent-xyz")
    assert.equal(results.length, 0)
  })
})
