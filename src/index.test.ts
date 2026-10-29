import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { server } from "./index.js"
import { addEntry, writeStore } from "./storage.js"
import { emptyReviewState, hashEntries, writeReviewState } from "./review.js"
import { AUDIT_AGENT_NAME } from "./auditAgent.js"

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-index-"))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function fakeInput(directory: string, calls: string[] = []) {
  const client = {
    session: {
      async create() { calls.push("create"); return { data: { id: "audit-sess" } } },
      async prompt(o: { body: { agent?: string } }) {
        calls.push(`prompt:${o.body.agent}`)
        return {
          data: {
            parts: [
              { type: "text", text: '{"findings":[{"ids":["MEM-001","MEM-002"],"relation":"duplicate","reason":"same"}]}' },
            ],
          },
        }
      },
      async delete() { calls.push("delete"); return {} },
    },
  }
  return { client, directory, project: {}, worktree: directory, serverUrl: new URL("http://localhost"), $: {} } as never
}

function seedStore(dir: string): Promise<unknown> {
  let s = addEntry({ entries: [], nextSeq: 1 }, "Rule one", "one").store
  s = addEntry(s, "Rule two", "two").store
  return writeStore(dir, s)
}

describe("plugin entry", () => {
  it("registers five tools, config, event and system transform hooks", async () => {
    await withDir(async (dir) => {
      const hooks = await server(fakeInput(dir))
      assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), [
        "memory_add",
        "memory_delete",
        "memory_read",
        "memory_review",
        "memory_update",
      ])
      assert.equal(typeof hooks.config, "function")
      assert.equal(typeof hooks.event, "function")
      assert.equal(typeof hooks["experimental.chat.system.transform"], "function")
    })
  })

  it("registers the audit agent, using small_model when present", async () => {
    await withDir(async (dir) => {
      const hooks = await server(fakeInput(dir))
      const cfg: { agent?: Record<string, any>; small_model?: string } = { small_model: "anthropic/claude-haiku" }
      await hooks.config!(cfg as never)
      const a = cfg.agent![AUDIT_AGENT_NAME]!
      assert.equal(a.mode, "subagent")
      assert.equal(a.hidden, true)
      assert.deepEqual(a.permission, { "*": "deny" })
      assert.equal(a.model, "anthropic/claude-haiku")
    })
  })

  it("does not register the agent when the audit is disabled", async () => {
    await withDir(async (dir) => {
      const hooks = await server(fakeInput(dir), { backgroundAudit: false })
      const cfg: { agent?: Record<string, unknown> } = {}
      await hooks.config!(cfg as never)
      assert.equal(cfg.agent, undefined)
    })
  })

  it("system transform injects the nudge only when something needs review", async () => {
    await withDir(async (dir) => {
      const s = addEntry({ entries: [], nextSeq: 1 }, "Rule one", "one").store
      const withTwo = addEntry(s, "Rule two", "two").store
      await writeStore(dir, withTwo)
      const hooks = await server(fakeInput(dir))
      const transform = hooks["experimental.chat.system.transform"]!

      const quiet = { system: [] as string[] }
      await transform({ sessionID: "s1", model: {} as never }, quiet)
      assert.doesNotMatch(quiet.system.join("\n"), /Memory maintenance/)

      await writeReviewState(dir, {
        ...emptyReviewState(),
        findings: [{ ids: ["MEM-001", "MEM-002"], relation: "contradiction", reason: "x", hash: hashEntries(withTwo.entries) }],
      })
      const loud = { system: [] as string[] }
      await transform({ sessionID: "s1", model: {} as never }, loud)
      assert.match(loud.system.join("\n"), /Memory maintenance: 1 possible memory conflict/)
    })
  })

  it("session.idle triggers one background audit under the audit agent", async () => {
    await withDir(async (dir) => {
      await seedStore(dir)
      const calls: string[] = []
      const hooks = await server(fakeInput(dir, calls))
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "real-1" } } as never })
      for (let i = 0; i < 100 && !calls.includes("delete"); i++) await new Promise((r) => setTimeout(r, 10))
      assert.deepEqual(calls, ["create", "prompt:memory-audit", "delete"])
      const raw = JSON.parse(await fs.readFile(path.join(dir, ".opencode/memory/review.json"), "utf8"))
      assert.equal(raw.findings.length, 1)
    })
  })

  it("the audit session is ignored by both hooks", async () => {
    await withDir(async (dir) => {
      await seedStore(dir)
      const calls: string[] = []
      const hooks = await server(fakeInput(dir, calls))
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "real-1" } } as never })
      for (let i = 0; i < 100 && !calls.includes("delete"); i++) await new Promise((r) => setTimeout(r, 10))
      calls.length = 0
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "audit-sess" } } as never })
      await new Promise((r) => setTimeout(r, 30))
      assert.deepEqual(calls, [])
      const out = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]!({ sessionID: "audit-sess", model: {} as never }, out)
      assert.equal(out.system.join(""), "")
    })
  })
})
