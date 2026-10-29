import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { createMemoryTools } from "./tools.js"
import { readStore, writeStore, addEntry } from "./storage.js"
import { readReviewState, writeReviewState, emptyReviewState, hashEntries } from "./review.js"
import { DEFAULT_CONFIG } from "./types.js"
import type { Logger } from "./logging.js"
import type { MemoryStore } from "./types.js"

const lines: string[] = []
const logger: Logger = {
  async info(a, d = "") { lines.push(`${a} ${d}`) },
  async error(a, e) { lines.push(`ERR ${a} ${String(e)}`) },
}
const tools = createMemoryTools(DEFAULT_CONFIG, logger)

type Out = { title: string; output: string }
async function run(tool: unknown, args: Record<string, unknown>, dir: string): Promise<Out> {
  const t = tool as { execute: (a: unknown, c: unknown) => Promise<Out | string> }
  const r = await t.execute(args, { directory: dir })
  return typeof r === "string" ? { title: "", output: r } : r
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-tools-"))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function seed(dir: string, ...items: Array<[string, string, string[]?]>): Promise<MemoryStore> {
  let s: MemoryStore = { entries: [], nextSeq: 1 }
  for (const [t, c, tags] of items) s = addEntry(s, t, c, tags).store
  await writeStore(dir, s)
  return s
}

describe("memory_add", () => {
  it("does not rank or list related memories — similarity is the model's job", async () => {
    await withDir(async (dir) => {
      await seed(
        dir,
        ["WebFetch 必须走 subagent，避免 context 膨胀", "当 webfetch 的目的是提取信息，必须用 Task subagent 做。"],
        ["SQLite 字段命名", "不得用保留关键字"],
      )
      const r = await run(tools.memory_add, { title: "WebFetch: always delegate to a subagent", content: "Delegate page fetching." }, dir)
      assert.match(r.output, /Saved as \[MEM-003\]/)
      assert.doesNotMatch(r.output, /Related existing memories/)
      assert.doesNotMatch(r.output, /overlap \d/)
      assert.match(r.output, /memory_review with refresh=true/)
    })
  })

  it("omits the refresh hint when this is the first memory", async () => {
    await withDir(async (dir) => {
      assert.doesNotMatch((await run(tools.memory_add, { title: "First", content: "c" }, dir)).output, /refresh=true/)
    })
  })

  it("supersedes: archives the old entry with a link and reports it", async () => {
    await withDir(async (dir) => {
      await seed(dir, ["Old rule", "old"], ["Other", "o"])
      const r = await run(tools.memory_add, { title: "New rule", content: "new", supersedes: ["MEM-001"] }, dir)
      assert.match(r.output, /Archived \(superseded by MEM-003\): MEM-001/)
      const store = await readStore(dir)
      const old = store.entries.find((e) => e.id === "MEM-001")!
      assert.equal(old.archived, true)
      assert.equal(old.supersededBy, "MEM-003")
    })
  })

  it("supersedes with a bad id saves nothing", async () => {
    await withDir(async (dir) => {
      await seed(dir, ["Old rule", "old"])
      const r = await run(tools.memory_add, { title: "New", content: "n", supersedes: ["MEM-001", "MEM-042"] }, dir)
      assert.equal(r.title, "Memory not saved")
      assert.match(r.output, /MEM-042/)
      const store = await readStore(dir)
      assert.equal(store.entries.length, 1)
      assert.equal(store.entries[0]!.archived, false)
    })
  })

  it("writes the summary file", async () => {
    await withDir(async (dir) => {
      await run(tools.memory_add, { title: "Hello", content: "c" }, dir)
      assert.match(await fs.readFile(path.join(dir, ".opencode/memory/memory_summary.md"), "utf8"), /Hello/)
    })
  })
})

describe("memory_delete", () => {
  it("stores the reason and replacement on the archived entry", async () => {
    await withDir(async (dir) => {
      await seed(dir, ["A", "a"], ["B", "b"])
      const r = await run(tools.memory_delete, { id: "MEM-001", reason: "merged into B", superseded_by: "MEM-002" }, dir)
      assert.match(r.output, /Reason: merged into B/)
      const e = (await readStore(dir)).entries.find((x) => x.id === "MEM-001")!
      assert.equal(e.archivedReason, "merged into B")
      assert.equal(e.supersededBy, "MEM-002")
      assert.ok(lines.some((l) => l.startsWith("memory_delete MEM-001") && l.includes("merged into B")))
    })
  })

  it("rejects a superseded_by that is missing or the same entry", async () => {
    await withDir(async (dir) => {
      await seed(dir, ["A", "a"])
      for (const sb of ["MEM-009", "MEM-001"]) {
        assert.equal((await run(tools.memory_delete, { id: "MEM-001", superseded_by: sb }, dir)).title, "Memory not archived")
      }
      assert.equal((await readStore(dir)).entries[0]!.archived, false)
    })
  })

  it("reports an unknown id", async () => {
    await withDir(async (dir) => {
      assert.equal((await run(tools.memory_delete, { id: "MEM-005" }, dir)).title, "Memory not found")
    })
  })
})

describe("memory_update", () => {
  it("logs the previous text when content changes", async () => {
    await withDir(async (dir) => {
      await seed(dir, ["Title", "old body"])
      lines.length = 0
      await run(tools.memory_update, { id: "MEM-001", content: "new body" }, dir)
      const log = lines.find((l) => l.startsWith("memory_update MEM-001"))!
      assert.match(log, /previous=/)
      assert.match(log, /old body/)
    })
  })

  it("with only an id, re-confirms: bumps updated, leaves text alone", async () => {
    await withDir(async (dir) => {
      const s = await seed(dir, ["Title", "body"])
      s.entries[0] = { ...s.entries[0]!, added: "2025-01-01" }
      await writeStore(dir, s)
      lines.length = 0
      await run(tools.memory_update, { id: "MEM-001" }, dir)
      const e = (await readStore(dir)).entries[0]!
      assert.equal(e.title, "Title")
      assert.equal(e.content, "body")
      assert.equal(e.added, "2025-01-01")
      assert.equal(e.updated, new Date().toISOString().slice(0, 10))
      assert.ok(lines.some((l) => l.includes("reconfirmed")))
    })
  })
})

describe("memory_read", () => {
  it("hides archived entries by default and shows reason/successor on request", async () => {
    await withDir(async (dir) => {
      await seed(dir, ["Old thing", "old"], ["New thing", "new"])
      await run(tools.memory_delete, { id: "MEM-001", reason: "replaced", superseded_by: "MEM-002" }, dir)
      assert.doesNotMatch((await run(tools.memory_read, {}, dir)).output, /Old thing/)
      const full = await run(tools.memory_read, { include_archived: true }, dir)
      assert.match(full.output, /Old thing/)
      assert.match(full.output, /reason: replaced/)
      assert.match(full.output, /superseded by MEM-002/)
    })
  })

  it("filters archived entries by query too", async () => {
    await withDir(async (dir) => {
      await seed(dir, ["Alpha", "a"], ["Beta", "b"])
      await run(tools.memory_delete, { id: "MEM-001" }, dir)
      await run(tools.memory_delete, { id: "MEM-002" }, dir)
      const r = await run(tools.memory_read, { query: "alpha", include_archived: true }, dir)
      assert.match(r.output, /Alpha/)
      assert.doesNotMatch(r.output, /Beta/)
    })
  })
})

describe("memory_review", () => {
  it("shows a placeholder, then honours dismiss", async () => {
    await withDir(async (dir) => {
      await seed(dir, ["plugin load check", "t", ["test"]], ["Real rule", "r"])
      assert.match((await run(tools.memory_review, {}, dir)).output, /key: MEM-001/)
      const after = await run(tools.memory_review, { dismiss: ["MEM-001"] }, dir)
      assert.match(after.output, /Dismissed: MEM-001/)
      assert.doesNotMatch(after.output, /key: MEM-001/)
    })
  })

  it("shows an audit finding with full text and removes it once an entry is edited", async () => {
    await withDir(async (dir) => {
      const s = await seed(dir, ["Rule one", "text one"], ["Rule two", "text two"])
      await writeReviewState(dir, {
        ...emptyReviewState(),
        findings: [{ ids: ["MEM-001", "MEM-002"], relation: "contradiction", reason: "they disagree", hash: hashEntries(s.entries) }],
      })
      const shown = await run(tools.memory_review, {}, dir)
      assert.match(shown.output, /they disagree/)
      assert.match(shown.output, /text one/)
      assert.match(shown.output, /text two/)
      await run(tools.memory_update, { id: "MEM-002", content: "text two, revised" }, dir)
      assert.doesNotMatch((await run(tools.memory_review, {}, dir)).output, /they disagree/)
    })
  })

  it("ignores unknown dismiss keys", async () => {
    await withDir(async (dir) => {
      await seed(dir, ["A", "a"])
      const r = await run(tools.memory_review, { dismiss: ["MEM-8+MEM-9"] }, dir)
      assert.match(r.output, /Not a current review item/)
      assert.equal((await readReviewState(dir)).dismissed.length, 0)
    })
  })

  it("lists aging entries", async () => {
    await withDir(async (dir) => {
      const s = await seed(dir, ["Ancient", "a"])
      s.entries[0] = { ...s.entries[0]!, added: "2020-01-01" }
      await writeStore(dir, s)
      const r = await run(tools.memory_review, {}, dir)
      assert.match(r.output, /Aging entries/)
      assert.match(r.output, /Ancient/)
    })
  })

  it("refresh runs the audit and shows the findings it produced", async () => {
    await withDir(async (dir) => {
      const s = await seed(dir, ["Rule one", "text one"], ["Rule two", "text two"])
      let ran = 0
      const withAudit = createMemoryTools(DEFAULT_CONFIG, logger, {
        runAuditNow: async () => {
          ran++
          await writeReviewState(dir, {
            ...emptyReviewState(),
            findings: [{ ids: ["MEM-001", "MEM-002"], relation: "duplicate", reason: "same rule", hash: hashEntries(s.entries) }],
          })
          return "done"
        },
      })
      const r = await run(withAudit.memory_review, { refresh: true }, dir)
      assert.equal(ran, 1)
      assert.match(r.output, /Audit run: done/)
      assert.match(r.output, /same rule/)
      assert.match(r.output, /text one/)
    })
  })

  it("refresh is a no-op note when the audit is disabled", async () => {
    await withDir(async (dir) => {
      await seed(dir, ["A", "a"], ["B", "b"])
      let ran = 0
      const disabled = createMemoryTools({ ...DEFAULT_CONFIG, backgroundAudit: false }, logger, {
        runAuditNow: async () => { ran++; return "done" },
      })
      const r = await run(disabled.memory_review, { refresh: true }, dir)
      assert.equal(ran, 0)
      assert.match(r.output, /Background audit is disabled/)
    })
  })
})
