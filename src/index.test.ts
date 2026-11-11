import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { resolveConfig, server, setup } from "./plugin.js"
import defaultExport from "./index.js"
import { activeDir, writeMemoryFile } from "./storage.js"
import { generateSummary } from "./summary.js"

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-index-"))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function fakeInput(directory: string) {
  return { directory, project: {}, worktree: directory, serverUrl: new URL("http://localhost"), $: {} } as never
}

async function seedStale(dir: string): Promise<void> {
  await writeMemoryFile(activeDir(dir), {
    id: "mem-aaaa0001",
    title: "Ancient rule",
    body: "old",
    proposedAt: "2020-01-01",
    approvedAt: "2020-01-01",
  })
}

describe("resolveConfig", () => {
  it("applies defaults and validates positive numbers", () => {
    assert.equal(resolveConfig().maxSummaryChars, 2000)
    assert.equal(resolveConfig().enableLog, true)
    assert.equal(resolveConfig().staleDays, 90)
    assert.equal(resolveConfig().backgroundAudit, true)
    assert.equal(resolveConfig().auditIntervalMinutes, 1)
    assert.equal(resolveConfig({}).maxSummaryChars, 2000)
  })

  it("accepts overrides and ignores junk", () => {
    const c = resolveConfig({ maxSummaryChars: 3000, staleDays: 7, backgroundAudit: false, enableLog: false })
    assert.equal(c.maxSummaryChars, 3000)
    assert.equal(c.staleDays, 7)
    assert.equal(c.backgroundAudit, false)
    assert.equal(c.enableLog, false)
    assert.equal(resolveConfig({ staleDays: -5 }).staleDays, 90)
  })
})

describe("plugin entry", () => {
  it("registers five tools, the event hook and the system transform hook", async () => {
    await withDir(async (dir) => {
      const hooks = await server(fakeInput(dir))
      assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), [
        "memory_delete",
        "memory_propose",
        "memory_read",
        "memory_review",
        "memory_update",
      ])
      assert.equal(typeof hooks.event, "function")
      assert.equal(typeof hooks["experimental.chat.system.transform"], "function")
      assert.equal(typeof hooks.config, "function")
    })
  })

  it("system transform bootstraps the summary and injects the index plus policy", async () => {
    await withDir(async (dir) => {
      await seedStale(dir)
      const hooks = await server(fakeInput(dir))
      const out = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]!({ sessionID: "s1", model: {} as never }, out)
      const text = out.system.join("\n")
      assert.match(text, /Ancient rule/)
      assert.match(text, /PR-gated project memory system/)
      assert.match(text, /memory_propose/)
    })
  })

  it("config hook registers the restricted audit agent", async () => {
    await withDir(async (dir) => {
      const hooks = await server(fakeInput(dir))
      const cfg = { agent: {} }
      await hooks.config!(cfg as never)
      assert.ok((cfg.agent as Record<string, unknown>)["memory-audit"])
    })
  })

  it("migrates a legacy store on startup", async () => {
    await withDir(async (dir) => {
      await fs.mkdir(path.join(dir, ".opencode/memory"), { recursive: true })
      await fs.writeFile(
        path.join(dir, ".opencode/memory/MEMORY.md"),
        "# OpenCode Memory\n<!-- nextSeq: 2 -->\n\n## Active\n\n### [MEM-001] Legacy rule\n- added: 2026-01-01\nOld body.\n\n## Archived\n",
        "utf8",
      )
      await server(fakeInput(dir))
      const summary = await fs.readFile(path.join(dir, "memory/_summary.md"), "utf8")
      assert.match(summary, /Legacy rule/)
    })
  })
})

describe("V2 entry", () => {
  function mockCtx(dir: string, options?: Record<string, unknown>) {
    const tools: Record<string, any> = {}
    const hooks: Record<string, (e: any) => unknown> = {}
    const disposed: string[] = []
    const ctx = {
      location: { directory: dir },
      ...(options ? { options } : {}),
      tool: {
        async transform(fn: (e: { add: (t: any) => void }) => void) {
          fn({ add: (t) => { tools[t.name] = t } })
          return { dispose: async () => { disposed.push("tool") } }
        },
      },
      session: {
        async hook(name: string, cb: (e: any) => unknown) {
          hooks[name] = cb
          return { dispose: async () => { disposed.push(name) } }
        },
      },
    }
    return { ctx, tools, hooks, disposed }
  }

  it("default export is { id, setup } and keeps server for V1", () => {
    assert.equal(typeof defaultExport.id, "string")
    assert.equal(typeof defaultExport.setup, "function")
    assert.equal(typeof defaultExport.server, "function")
  })

  it("setup registers five tools that execute, injects context, and disposes", async () => {
    await withDir(async (dir) => {
      await seedStale(dir)
      await generateSummary(dir)
      const m = mockCtx(dir)
      const cleanup = await setup(m.ctx as never)
      assert.deepEqual(Object.keys(m.tools).sort(), [
        "memory_delete", "memory_propose", "memory_read", "memory_review", "memory_update",
      ])

      const added = await m.tools["memory_propose"].execute({ title: "Rule three", content: "three" })
      assert.match(added.content, /Proposed \[mem-/)

      const event = { sessionID: "s1", system: [] as Array<{ type: string; text: string }> }
      await m.hooks["context"]!(event)
      assert.equal(event.system.length, 1)
      assert.equal(event.system[0]!.type, "text")
      assert.match(event.system[0]!.text, /Ancient rule/)

      await cleanup()
      assert.deepEqual(m.disposed.sort(), ["context", "experimental.idle", "tool"])
    })
  })

  it("does not register the idle hook when the audit is disabled", async () => {
    await withDir(async (dir) => {
      const m = mockCtx(dir, { backgroundAudit: false })
      await setup(m.ctx as never)
      assert.equal(m.hooks["experimental.idle"], undefined)
    })
  })
})
