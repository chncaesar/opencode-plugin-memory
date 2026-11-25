import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { buildIndexLines, buildSystemPrompt, loadPromptBlock } from "./summary.js"
import { MEMORY_POLICY_EXAMPLES, MEMORY_WRITE_POLICY } from "./prompt.js"
import { activeDir, writeMemoryFile } from "./storage.js"
import type { StoreSet } from "./stores.js"
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

/** Project-only stores: the global store is absent, as on a machine without a clone. */
function projectOnly(projectDir: string): StoreSet {
  return {
    project: { scope: "project", root: projectDir },
    defaultScope: "project",
    globalPath: path.join(projectDir, "no-global-here"),
    globalProblem: "missing",
  }
}

function both(projectDir: string, globalDir: string): StoreSet {
  return {
    global: { scope: "global", root: globalDir },
    project: { scope: "project", root: projectDir },
    defaultScope: "global",
    globalPath: globalDir,
  }
}

const GLOBAL_HEADING = "Global memory index:"
const PROJECT_HEADING = "Project memory index (this repository):"

/** The text of one index section, up to the next heading or the policy. */
function section(block: string, heading: string, next?: string): string {
  const start = block.indexOf(heading)
  assert.ok(start >= 0, `missing heading ${heading}`)
  const rest = block.slice(start + heading.length)
  const stops = [rest.indexOf("\n\n## When to propose"), next !== undefined ? rest.indexOf(next) : -1].filter((i) => i >= 0)
  const end = stops.length > 0 ? Math.min(...stops) : -1
  return end >= 0 ? rest.slice(0, end) : rest
}

const longTitle = (label: string) => `${label}: ${"细节".repeat(30)}`

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

describe("loadPromptBlock: unavailable project store", () => {
  it("shows the project index as unavailable, never as empty, and still indexes global", async () => {
    await withDir(async (dir) => {
      const globalDir = path.join(dir, "global")
      await writeMemoryFile(activeDir(globalDir), mem("mem-aaaaaaaa", "Global rule"))
      const stores: StoreSet = {
        global: { scope: "global", root: globalDir },
        project: { scope: "project", root: path.join(dir, "uninitialized-managed-store") },
        projectProblem: "unavailable",
        defaultScope: "global",
        globalPath: globalDir,
      }
      const block = await loadPromptBlock(stores, 4000, 0.7)
      const projectSection = section(block, PROJECT_HEADING)
      assert.match(projectSection, /unavailable/i)
      assert.doesNotMatch(projectSection, /no active memories/)
      assert.match(section(block, GLOBAL_HEADING, PROJECT_HEADING), /\[mem-aaaaaaaa\] Global rule/)
    })
  })
})

describe("loadPromptBlock", () => {
  it("derives the project index from memory/active and writes nothing", async () => {
    await withDir(async (dir) => {
      await writeMemoryFile(activeDir(dir), mem("mem-aaaaaaaa", "First rule"))
      const block = await loadPromptBlock(projectOnly(dir), 2000, 0.7)
      assert.match(block, /\[mem-aaaaaaaa\] First rule/)
      // No index file is created or expected.
      await assert.rejects(fs.access(path.join(dir, "memory", "_summary.md")))
    })
  })

  it("renders an empty store without creating the memory folder", async () => {
    await withDir(async (dir) => {
      const block = await loadPromptBlock(projectOnly(dir), 2000, 0.7)
      assert.match(block, /no active memories/)
      await assert.rejects(fs.access(path.join(dir, "memory")))
    })
  })

  it("explains that global memory is unavailable instead of inventing an index", async () => {
    await withDir(async (dir) => {
      const block = await loadPromptBlock(projectOnly(dir), 2000, 0.7)
      assert.match(block, /Global memory is not configured this session/)
      // The concrete path belongs in tool output, never in the prompt.
      assert.ok(!block.includes("no-global-here"))
    })
  })

  it("injects both stores with separate headings and no cross-contamination", async () => {
    await withDir(async (projectDir) => {
      await withDir(async (globalDir) => {
        await writeMemoryFile(activeDir(projectDir), mem("mem-aaaaaaaa", "Project rule"))
        await writeMemoryFile(activeDir(globalDir), mem("mem-bbbbbbbb", "Global rule"))
        const block = await loadPromptBlock(both(projectDir, globalDir), 4000, 0.7)
        const globalPart = section(block, GLOBAL_HEADING, PROJECT_HEADING)
        const projectPart = section(block, PROJECT_HEADING)
        assert.match(globalPart, /\[mem-bbbbbbbb\] Global rule/)
        assert.ok(!globalPart.includes("Project rule"))
        assert.match(projectPart, /\[mem-aaaaaaaa\] Project rule/)
        assert.ok(!projectPart.includes("Global rule"))
      })
    })
  })

  it("does not throw when a store cannot be read, and keeps the policy", async () => {
    await withDir(async (dir) => {
      await fs.mkdir(path.dirname(activeDir(dir)), { recursive: true })
      await fs.writeFile(activeDir(dir), "not a directory", "utf8")
      const reported: string[][] = []
      const block = await loadPromptBlock(projectOnly(dir), 2000, 0.7, (problems) => {
        reported.push(problems.map((p) => p.code))
      })
      assert.match(block, /memory index unavailable/)
      assert.ok(block.includes(MEMORY_WRITE_POLICY))
      assert.ok(!block.includes("no active memories"))
      assert.deepEqual(reported, [["ENOTDIR"]])
      // No filesystem text or path leaks into the prompt.
      assert.ok(!/ENOTDIR|EACCES|no such file|\.memory/i.test(block.split("## When to propose")[0]!))
    })
  })

  it("keeps the readable entries and reports a skipped file without leaking its error", async () => {
    await withDir(async (dir) => {
      await writeMemoryFile(activeDir(dir), mem("mem-aaaaaaaa", "Readable rule"))
      await fs.mkdir(path.join(activeDir(dir), "mem-bbbbbbbb.md"))
      const reported: string[][] = []
      const block = await loadPromptBlock(projectOnly(dir), 2000, 0.7, (problems) => {
        reported.push(problems.map((p) => p.code))
      })
      assert.match(block, /\[mem-aaaaaaaa\] Readable rule/)
      assert.match(block, /1 memory file could not be read/)
      assert.deepEqual(reported, [["EISDIR"]])
      const indexPart = block.split(PROJECT_HEADING)[1]!.split("## When to propose")[0]!
      assert.ok(!/EISDIR|EACCES|cannot read/i.test(indexPart))
    })
  })

  it("still renders the prompt when the diagnostics reporter throws", async () => {
    await withDir(async (dir) => {
      await fs.mkdir(path.join(activeDir(dir), "mem-bbbbbbbb.md"), { recursive: true })
      const block = await loadPromptBlock(projectOnly(dir), 2000, 0.7, () => {
        throw new Error("reporter exploded")
      })
      assert.ok(block.includes(MEMORY_WRITE_POLICY))
    })
  })
})

describe("index budget", () => {
  it("keeps every project entry visible when the global store overflows", async () => {
    await withDir(async (projectDir) => {
      await withDir(async (globalDir) => {
        for (let i = 0; i < 3; i++) {
          await writeMemoryFile(activeDir(projectDir), mem(`mem-p${String(i).padStart(7, "0")}`, longTitle(`project ${i}`)))
        }
        for (let i = 0; i < 20; i++) {
          await writeMemoryFile(activeDir(globalDir), mem(`mem-g${String(i).padStart(7, "0")}`, longTitle(`global ${i}`)))
        }
        const block = await loadPromptBlock(both(projectDir, globalDir), 1000, 0.7)
        const projectPart = section(block, PROJECT_HEADING)
        for (let i = 0; i < 3; i++) assert.ok(projectPart.includes(`project ${i}`), `project ${i} was crowded out`)
        assert.match(section(block, GLOBAL_HEADING, PROJECT_HEADING), /showing \d+ — use memory_read/)
      })
    })
  })

  it("lets the global store use budget the project store does not need", async () => {
    await withDir(async (projectDir) => {
      await withDir(async (globalDir) => {
        await writeMemoryFile(activeDir(projectDir), mem("mem-aaaaaaaa", "Only project rule"))
        for (let i = 0; i < 20; i++) {
          await writeMemoryFile(activeDir(globalDir), mem(`mem-g${String(i).padStart(7, "0")}`, longTitle(`global ${i}`)))
        }
        const block = await loadPromptBlock(both(projectDir, globalDir), 1000, 0.7)
        const shown = (section(block, GLOBAL_HEADING, PROJECT_HEADING).match(/\[mem-/g) ?? []).length
        // With a hard 70% cap this store could show about 8 of these 85-char
        // lines; borrowing the project's unused share must show more.
        assert.ok(shown >= 10, `global index only showed ${shown} lines`)
      })
    })
  })

  it("keeps the project reservation when both stores are large", async () => {
    const globalMemories = Array.from({ length: 40 }, (_, i) => mem(`mem-g${String(i).padStart(7, "0")}`, longTitle(`global ${i}`)))
    const projectMemories = Array.from({ length: 10 }, (_, i) => mem(`mem-p${String(i).padStart(7, "0")}`, longTitle(`project ${i}`)))
    const out = buildSystemPrompt(
      {
        global: { scope: "global", memories: globalMemories, omitted: 0, unavailable: false },
        project: { scope: "project", memories: projectMemories, omitted: 0, unavailable: false },
      },
      1000,
      0.7,
    )
    const projectShown = (section(out, PROJECT_HEADING).match(/\[mem-/g) ?? []).length
    // The project store is guaranteed 30% of 1000 characters, which is a few
    // entries here — never zero.
    assert.ok(projectShown >= 2, `project index showed only ${projectShown} lines`)
    assert.match(section(out, GLOBAL_HEADING, PROJECT_HEADING), /showing \d+ — use memory_read/)
  })
})

describe("buildSystemPrompt", () => {
  it("names both stores and the default, and never dumps bodies", () => {
    const out = buildSystemPrompt(
      {
        global: { scope: "global", memories: [{ ...mem("mem-gggggggg", "Global rule"), body: "very long body" }], omitted: 0, unavailable: false },
        project: { scope: "project", memories: [], omitted: 0, unavailable: false },
      },
      4000,
      0.7,
    )
    assert.match(out, /GLOBAL/)
    assert.match(out, /PROJECT/)
    assert.match(out, /\[mem-gggggggg\] Global rule/)
    assert.ok(!out.includes("very long body"))
    assert.ok(out.includes(MEMORY_WRITE_POLICY))
  })

  it("fits all 56 realistic titles under the 10000-char default cap", () => {
    const memories = Array.from({ length: 56 }, (_, i) =>
      mem(`mem-${String(i).padStart(8, "0")}`, `${"标题".repeat(40)} ${i}`),
    )
    const out = buildSystemPrompt(
      {
        global: { scope: "global", memories: memories.slice(0, 40), omitted: 0, unavailable: false },
        project: { scope: "project", memories: memories.slice(40), omitted: 0, unavailable: false },
      },
      10000,
      0.7,
    )
    for (const m of memories) assert.ok(out.includes(`[${m.id}] ${m.title}`))
    assert.ok(!out.includes("showing"))
  })
})

describe("memory-writing policy", () => {
  it("covers corrections, confirmations, temporary limits, and task-local requests", () => {
    for (const signal of ["correction", "confirmation", "temporary", "task-local"] as const) {
      assert.ok(MEMORY_POLICY_EXAMPLES.some((e) => e.signal === signal), `missing ${signal} example`)
    }
  })

  it("teaches the PR gate and the tool names", () => {
    assert.match(MEMORY_WRITE_POLICY, /PROPOSE/i)
    assert.match(MEMORY_WRITE_POLICY, /memory_propose/)
    assert.match(MEMORY_WRITE_POLICY, /memory_update/)
    assert.match(MEMORY_WRITE_POLICY, /memory_delete/)
    assert.match(MEMORY_WRITE_POLICY, /merge/i)
  })

  it("teaches which store to choose", () => {
    assert.match(MEMORY_WRITE_POLICY, /## Which store: global or project/)
    assert.match(MEMORY_WRITE_POLICY, /would this still be right in a different repository\?/)
    assert.match(MEMORY_WRITE_POLICY, /A supersede stays inside one store/)
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

  it("tests the candidate against the artifact a future session will read", () => {
    assert.match(MEMORY_WRITE_POLICY, /Memory is not a task list, and not a copy of the artifact/)
    assert.match(MEMORY_WRITE_POLICY, /once this rule is done, will the artifact state it\?/)
    assert.ok(
      MEMORY_POLICY_EXAMPLES.some((e) => e.signal === "already-encoded" && e.decision === "skip"),
      "missing skip example for a rule already implemented this turn",
    )
    assert.ok(
      MEMORY_POLICY_EXAMPLES.some((e) => e.signal === "pending" && e.decision === "skip"),
      "missing skip example for a requirement that is not built yet",
    )
    assert.ok(
      MEMORY_POLICY_EXAMPLES.some((e) => e.decision === "save" && /never /i.test(e.cue)),
      "missing save example for a boundary the artifact cannot state",
    )
    assert.ok(
      MEMORY_POLICY_EXAMPLES.some((e) => e.decision === "save" && /hazard, not the procedure/i.test(e.guidance)),
      "deployment anchor example no longer explains why it survives the artifact test",
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
