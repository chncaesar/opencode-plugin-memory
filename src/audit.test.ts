import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  activeHash,
  buildAuditPrompt,
  auditFailureHint,
  auditWarning,
  chatCompletionsUrl,
  createAuditScheduler,
  createHttpModelCall,
  describeAuditStatus,
  looksLikeContextOverflow,
  looksLikeCredentialProblem,
  parseAuditResponse,
  relationToReason,
  orderBySimilarity,
  resolveSecretValue,
  runAudit,
  splitIntoBatches,
  type ModelCall,
} from "./audit.js"
import { activeDir, listStagedProposals, writeMemoryFile } from "./storage.js"
import { DEFAULT_CONFIG, type Memory, type PluginConfig } from "./types.js"
import type { Logger } from "./logging.js"

const quietLogger: Logger = { async info() {}, async error() {} }

function mem(id: string, title: string, body = "body"): Memory {
  return { id, title, body, proposedAt: "2026-01-01" }
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-audit-"))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const cfg = (over: Partial<PluginConfig> = {}): PluginConfig => ({ ...DEFAULT_CONFIG, ...over })
const NOW = new Date("2026-11-01T00:00:00Z")
const later = (min: number) => new Date(NOW.getTime() + min * 60_000)

function findingReply(findings: unknown[]): ModelCall {
  return async () => JSON.stringify({ findings })
}

async function seed(dir: string, ...memories: Memory[]): Promise<void> {
  for (const m of memories) await writeMemoryFile(activeDir(dir), m)
}

describe("buildAuditPrompt", () => {
  it("lists id, title, tags and body per entry", () => {
    const out = buildAuditPrompt([{ id: "mem-aaaaaaaa", title: "A rule", body: "do X", tags: ["style"] }])
    assert.match(out, /\[mem-aaaaaaaa\] A rule/)
    assert.match(out, /tags: style/)
    assert.match(out, /do X/)
  })
})

describe("parseAuditResponse", () => {
  const active = [mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"), mem("mem-cccc0003", "C")]

  it("parses valid findings and drops unknown ids and duplicates", () => {
    const findings = parseAuditResponse(
      JSON.stringify({
        findings: [
          { relation: "duplicate", retire: "mem-aaaa0001", superseded_by: "mem-bbbb0002", reason: "same" },
          { relation: "refinement", retire: "mem-aaaa0001", superseded_by: "mem-cccc0003", reason: "again" },
          { relation: "contradiction", retire: "mem-zzzz9999", reason: "bad id" },
          { relation: "bogus", retire: "mem-bbbb0002", reason: "bad relation" },
        ],
      }),
      active,
    )
    assert.equal(findings!.length, 1)
    assert.equal(findings![0]!.relation, "duplicate")
    assert.equal(findings![0]!.retire, "mem-aaaa0001")
    assert.equal(findings![0]!.supersededBy, "mem-bbbb0002")
  })

  it("returns null for a non-JSON reply", () => {
    assert.equal(parseAuditResponse("I found nothing interesting", active), null)
  })
})

describe("relationToReason", () => {
  it("maps relations onto the retirement vocabulary", () => {
    assert.equal(relationToReason("duplicate"), "duplicate")
    assert.equal(relationToReason("contradiction"), "wrong")
    assert.equal(relationToReason("refinement"), "superseded")
  })
})

describe("activeHash", () => {
  it("is order-independent and changes with content", () => {
    const a = [mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B")]
    const b = [mem("mem-bbbb0002", "B"), mem("mem-aaaa0001", "A")]
    assert.equal(activeHash(a), activeHash(b))
    assert.notEqual(activeHash(a), activeHash([mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "Changed")]))
  })
})

describe("runAudit", () => {
  it("is disabled when backgroundAudit is off", async () => {
    await withDir(async (dir) => {
      await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"))
      const out = await runAudit({ directory: dir, config: cfg({ backgroundAudit: false }), logger: quietLogger, call: findingReply([]), now: () => NOW })
      assert.equal(out, "disabled")
    })
  })

  it("skips when there are fewer than two active memories", async () => {
    await withDir(async (dir) => {
      await seed(dir, mem("mem-aaaa0001", "A"))
      const out = await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call: findingReply([]), now: () => NOW })
      assert.equal(out, "skipped-too-few")
    })
  })

  it("asks the model and emits a retire proposal per finding", async () => {
    await withDir(async (dir) => {
      await seed(dir, mem("mem-aaaa0001", "Old"), mem("mem-bbbb0002", "New"))
      const out = await runAudit({
        directory: dir,
        config: cfg(),
        logger: quietLogger,
        call: findingReply([{ relation: "duplicate", retire: "mem-aaaa0001", superseded_by: "mem-bbbb0002", reason: "same fact" }]),
        now: () => NOW,
      })
      assert.equal(out, "done")
      const staged = await listStagedProposals(dir)
      assert.equal(staged.length, 1)
      assert.equal(staged[0]!.intent, "retire")
      assert.equal(staged[0]!.id, "mem-aaaa0001")
      assert.equal(staged[0]!.retiredReason, "duplicate")
      assert.equal(staged[0]!.supersededBy, "mem-bbbb0002")
      assert.match(staged[0]!.source ?? "", /duplicate/)
    })
  })

  it("skips a second run when nothing changed", async () => {
    await withDir(async (dir) => {
      await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"))
      const deps = { directory: dir, config: cfg(), logger: quietLogger, call: findingReply([]), now: () => NOW }
      assert.equal(await runAudit(deps), "done")
      assert.equal(await runAudit(deps), "skipped-unchanged")
    })
  })

  it("honours the minimum interval when memories changed", async () => {
    await withDir(async (dir) => {
      await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"))
      const intervalCfg = cfg({ auditIntervalMinutes: 60 })
      const first = { directory: dir, config: intervalCfg, logger: quietLogger, call: findingReply([]), now: () => NOW }
      assert.equal(await runAudit(first), "done")

      await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B changed"))
      const second = { directory: dir, config: intervalCfg, logger: quietLogger, call: findingReply([]), now: () => later(10) }
      assert.equal(await runAudit(second), "skipped-interval")

      const forced = { directory: dir, config: intervalCfg, logger: quietLogger, call: findingReply([]), now: () => later(10), force: true }
      assert.equal(await runAudit(forced), "done")
    })
  })

  it("does not re-propose a retirement already in staging", async () => {
    await withDir(async (dir) => {
      await seed(dir, mem("mem-aaaa0001", "Old"), mem("mem-bbbb0002", "New"))
      const call = findingReply([{ relation: "duplicate", retire: "mem-aaaa0001", reason: "same" }])
      assert.equal(await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call, now: () => NOW }), "done")
      assert.equal((await listStagedProposals(dir)).length, 1)

      // Change a memory so the hash differs, then re-run: the finding is the
      // same id, so no new proposal is written.
      await seed(dir, mem("mem-aaaa0001", "Old"), mem("mem-bbbb0002", "New changed"))
      assert.equal(await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call, now: () => later(120) }), "done")
      assert.equal((await listStagedProposals(dir)).length, 1)
    })
  })

  it("discards the verdict when memories change during the call", async () => {
    await withDir(async (dir) => {
      await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"))
      let calls = 0
      const call: ModelCall = async () => {
        calls++
        // mutate mid-call so the fresh re-read differs from the pre-call hash
        await writeMemoryFile(activeDir(dir), mem("mem-cccc0003", "C"))
        return JSON.stringify({ findings: [{ relation: "duplicate", retire: "mem-aaaa0001", reason: "x" }] })
      }
      const out = await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call, now: () => NOW })
      assert.equal(out, "discarded-changed")
      assert.equal(calls, 1)
      assert.equal((await listStagedProposals(dir)).length, 0)
    })
  })

  it("treats an unparsable reply as a failure", async () => {
    await withDir(async (dir) => {
      await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"))
      const out = await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call: async () => "not json", now: () => NOW })
      assert.equal(out, "failed")
    })
  })
})

describe("createAuditScheduler", () => {
  it("runs once for a burst of idle events", async () => {
    await withDir(async (dir) => {
      await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"))
      const call = findingReply([{ relation: "duplicate", retire: "mem-aaaa0001", reason: "same" }])
      const sch = createAuditScheduler({ directory: dir, config: cfg(), logger: quietLogger, call, now: () => NOW }, new Set())
      sch.onSessionIdle("s1")
      sch.onSessionIdle("s2")
      sch.onSessionIdle("s3")
      await sch.settled()
      assert.equal((await listStagedProposals(dir)).length, 1)
    })
  })

  it("runNow bypasses the interval", async () => {
    await withDir(async (dir) => {
      await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"))
      const call = findingReply([])
      const sch = createAuditScheduler({ directory: dir, config: cfg(), logger: quietLogger, call, now: () => NOW }, new Set())
      assert.equal(await sch.runNow(), "done")
      // change memories, then runNow within the interval still runs (force)
      await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B2"))
      assert.equal(await sch.runNow(), "done")
    })
  })

  it("ignores idle events from audit sessions", async () => {
    await withDir(async (dir) => {
      await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"))
      let calls = 0
      const call: ModelCall = async () => {
        calls++
        return JSON.stringify({ findings: [] })
      }
      const auditSessions = new Set<string>(["audit-1"])
      const sch = createAuditScheduler({ directory: dir, config: cfg(), logger: quietLogger, call, now: () => NOW }, auditSessions)
      sch.onSessionIdle("audit-1")
      await sch.settled()
      assert.equal(calls, 0)
    })
  })
})

describe("batching", () => {
  const many = (n: number, body = "x".repeat(200)): Memory[] =>
    Array.from({ length: n }, (_, i) => mem(`mem-${String(i).padStart(8, "0")}`, `Title ${i}`, body))

  it("returns one batch, in the given order, when everything fits", () => {
    const ms = many(5)
    const out = splitIntoBatches(ms, 1_000_000)
    assert.equal(out.length, 1)
    assert.deepEqual(out[0]!.map((m) => m.id), ms.map((m) => m.id))
  })

  it("splits by size, keeps every entry, and overlaps consecutive batches", () => {
    const ms = many(30)
    const out = splitIntoBatches(ms, 2_000, 2)
    assert.ok(out.length > 1)
    const seen = new Set(out.flat().map((m) => m.id))
    assert.equal(seen.size, 30)
    for (let i = 1; i < out.length; i++) {
      const prevTail = out[i - 1]!.slice(-2).map((m) => m.id)
      assert.deepEqual(out[i]!.slice(0, 2).map((m) => m.id), prevTail)
    }
    for (const b of out) assert.ok(b.reduce((n, m) => n + m.id.length + m.title.length + m.body.length + 24, 0) <= 2_000)
  })

  it("gives an oversized entry its own batch instead of dropping it", () => {
    const ms = [mem("mem-aaaa0001", "small"), mem("mem-bbbb0002", "huge", "y".repeat(5_000)), mem("mem-cccc0003", "small too")]
    const out = splitIntoBatches(ms, 1_000, 0)
    assert.equal(new Set(out.flat().map((m) => m.id)).size, 3)
  })

  it("orders related entries next to each other and is deterministic", () => {
    const ms = [
      mem("mem-00000001", "Kingdee API field rules", "kingdee api field name"),
      mem("mem-00000002", "Metabase tooltip wording", "metabase tooltip description"),
      mem("mem-00000003", "Kingdee API sub entity keys", "kingdee api key"),
      mem("mem-00000004", "Metabase dashboard tooltip override", "metabase dashboard tooltip"),
    ]
    const a = orderBySimilarity(ms).map((m) => m.id)
    const b = orderBySimilarity([...ms].reverse()).map((m) => m.id)
    assert.deepEqual(a, b)
    const pos = (id: string) => a.indexOf(id)
    assert.equal(Math.abs(pos("mem-00000001") - pos("mem-00000003")), 1)
    assert.equal(Math.abs(pos("mem-00000002") - pos("mem-00000004")), 1)
  })

  it("groups Chinese titles by shared characters", () => {
    const ms = [
      mem("mem-00000001", "晶圆库存折算口径", "晶圆 库存"),
      mem("mem-00000002", "委外订单结案日期", "委外 结案"),
      mem("mem-00000003", "晶圆库存分类优先级", "晶圆 库存"),
    ]
    const a = orderBySimilarity(ms).map((m) => m.id)
    assert.equal(Math.abs(a.indexOf("mem-00000001") - a.indexOf("mem-00000003")), 1)
  })

  it("audits a large store in several calls and merges findings across batches", async () => {
    await withDir(async (dir) => {
      const ms = many(12)
      await seed(dir, ...ms)
      const prompts: string[] = []
      const call: ModelCall = async (_sys, prompt) => {
        prompts.push(prompt)
        const ids = [...prompt.matchAll(/\[(mem-\d{8})\]/g)].map((m) => m[1]!)
        // every batch reports the same pair it can see; the merged result must hold it once
        if (ids.includes("mem-00000000") && ids.includes("mem-00000001")) {
          return JSON.stringify({ findings: [{ relation: "duplicate", retire: "mem-00000000", superseded_by: "mem-00000001", reason: "same" }] })
        }
        return JSON.stringify({ findings: [{ relation: "duplicate", retire: ids[0], superseded_by: ids[1], reason: "r" }] })
      }
      const out = await runAudit({ directory: dir, config: cfg({ auditBatchChars: 1_500 }), logger: quietLogger, call, now: () => NOW })
      assert.equal(out, "done")
      assert.ok(prompts.length > 1)
      assert.match(prompts[0]!, /^Batch 1 of /)
      const staged = await listStagedProposals(dir)
      const ids = staged.map((p) => p.id)
      assert.equal(new Set(ids).size, ids.length)
      assert.ok(ids.length >= 1)
    })
  })

  it("does not cap the number of entries (formerly skipped above 200)", async () => {
    await withDir(async (dir) => {
      await seed(dir, ...many(205, "z"))
      let calls = 0
      const call: ModelCall = async () => {
        calls++
        return JSON.stringify({ findings: [] })
      }
      const out = await runAudit({ directory: dir, config: cfg({ auditBatchChars: 100_000 }), logger: quietLogger, call, now: () => NOW })
      assert.equal(out, "done")
      assert.ok(calls >= 1)
    })
  })

  it("fails the whole run without writing proposals or state when one batch fails", async () => {
    await withDir(async (dir) => {
      await seed(dir, ...many(12))
      let n = 0
      const call: ModelCall = async (_s, prompt) => {
        n++
        if (n === 2) throw new Error("model down")
        const ids = [...prompt.matchAll(/\[(mem-\d{8})\]/g)].map((m) => m[1]!)
        return JSON.stringify({ findings: [{ relation: "duplicate", retire: ids[0], superseded_by: ids[1], reason: "r" }] })
      }
      const out = await runAudit({ directory: dir, config: cfg({ auditBatchChars: 1_500 }), logger: quietLogger, call, now: () => NOW })
      assert.equal(out, "failed")
      assert.equal((await listStagedProposals(dir)).length, 0)
      // not marked as audited: a later run (after the interval) tries again
      const retry = await runAudit({ directory: dir, config: cfg({ auditBatchChars: 1_500 }), logger: quietLogger, call: findingReply([]), now: () => later(5) })
      assert.equal(retry, "done")
    })
  })
})

describe("audit failure visibility", () => {
  const failing = (msg: string): ModelCall => async () => {
    throw new Error(msg)
  }

  it("recognises context-window errors from common providers", () => {
    for (const m of [
      "This model's maximum context length is 65536 tokens",
      "context_length_exceeded",
      "Input is too long for requested model",
      "prompt is too long: 250000 tokens > 200000 maximum",
      "HTTP 413 Request Entity Too Large",
      "Request too large for gpt-4",
    ]) assert.ok(looksLikeContextOverflow(m), m)
    for (const m of ["fetch failed", "401 unauthorized", "rate limit reached", "model not found"]) assert.ok(!looksLikeContextOverflow(m), m)
  })

  it("tells the user to lower auditBatchChars on a context error and gives no advice otherwise", () => {
    const hint = auditFailureHint("maximum context length exceeded", cfg({ auditBatchChars: 400_000 }))
    assert.match(hint ?? "", /auditBatchChars/)
    assert.match(hint ?? "", /400000/)
    assert.match(hint ?? "", /100000/)
    assert.equal(auditFailureHint("fetch failed", cfg()), null)
  })

  it("records a failed run, notifies once, and stays quiet for the same repeated error", async () => {
    await withDir(async (dir) => {
      await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"))
      const notices: string[] = []
      const deps = { directory: dir, config: cfg(), logger: quietLogger, notify: (m: string) => void notices.push(m) }

      assert.equal(await runAudit({ ...deps, call: failing("maximum context length is 65536 tokens"), now: () => NOW }), "failed")
      assert.equal(notices.length, 1)
      assert.match(notices[0]!, /Memory audit failed/)
      assert.match(notices[0]!, /auditBatchChars/)

      // same error again, after the interval: still failed, no second notification
      assert.equal(await runAudit({ ...deps, call: failing("maximum context length is 65536 tokens"), now: () => later(5) }), "failed")
      assert.equal(notices.length, 1)

      // a different error is new information
      assert.equal(await runAudit({ ...deps, call: failing("401 unauthorized"), now: () => later(10) }), "failed")
      assert.equal(notices.length, 2)
    })
  })

  it("a notification that throws does not break the audit", async () => {
    await withDir(async (dir) => {
      await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"))
      const out = await runAudit({
        directory: dir, config: cfg(), logger: quietLogger, call: failing("boom"), now: () => NOW,
        notify: () => { throw new Error("no tui") },
      })
      assert.equal(out, "failed")
    })
  })

  it("an unusable model reply is recorded as a failure too", async () => {
    await withDir(async (dir) => {
      await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"))
      const out = await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call: async () => "not json at all", now: () => NOW })
      assert.equal(out, "failed")
      const lines = await describeAuditStatus(dir, cfg())
      assert.match(lines.join("\n"), /FAILED/)
      assert.match(lines.join("\n"), /not usable/)
    })
  })

  it("describeAuditStatus covers never-run, ok and disabled", async () => {
    await withDir(async (dir) => {
      assert.deepEqual(await describeAuditStatus(dir, cfg()), ["Not run yet in this project."])
      assert.match((await describeAuditStatus(dir, cfg({ backgroundAudit: false })))[0]!, /Disabled/)
      await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"))
      await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call: findingReply([]), now: () => NOW })
      assert.match((await describeAuditStatus(dir, cfg()))[0]!, /Last run: .* — ok/)
    })
  })

  it("a later successful run clears the failure", async () => {
    await withDir(async (dir) => {
      await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"))
      await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call: failing("boom"), now: () => NOW })
      await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call: findingReply([]), now: () => later(5) })
      const text = (await describeAuditStatus(dir, cfg())).join("\n")
      assert.match(text, /ok/)
      assert.ok(!/FAILED/.test(text))
    })
  })
})

describe("auditWarning (system prompt)", () => {
  it("is null before any run, after success and when the audit is disabled", async () => {
    await withDir(async (dir) => {
      assert.equal(await auditWarning(dir, cfg()), null)
      await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"))
      await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call: findingReply([]), now: () => NOW })
      assert.equal(await auditWarning(dir, cfg()), null)
      assert.equal(await auditWarning(dir, cfg({ backgroundAudit: false })), null)
    })
  })

  it("after a context-window failure it tells the model to warn the user and names the fix", async () => {
    await withDir(async (dir) => {
      await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"))
      await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call: async () => { throw new Error("maximum context length is 65536 tokens") }, now: () => NOW })
      const w = await auditWarning(dir, cfg())
      assert.match(w ?? "", /FAILED/)
      assert.match(w ?? "", /auditBatchChars/)
      assert.match(w ?? "", /Tell the user/)
      // cleared by the next success
      await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call: findingReply([]), now: () => later(5) })
      assert.equal(await auditWarning(dir, cfg()), null)
    })
  })
})

describe("direct provider call (auditProvider)", () => {
  function stubFetch(handler: (url: string, init: any) => Promise<Response>) {
    const original = globalThis.fetch
    const calls: Array<{ url: string; init: any }> = []
    globalThis.fetch = (async (input: any, init: any) => {
      calls.push({ url: String(input), init })
      return handler(String(input), init)
    }) as typeof fetch
    return {
      calls,
      restore: () => {
        globalThis.fetch = original
      },
    }
  }

  const reply = (text: string, status = 200) =>
    new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status })

  it("posts to /chat/completions with the configured model, bearer key and both messages", async () => {
    const stub = stubFetch(async () => reply('{"findings":[]}'))
    try {
      const call = createHttpModelCall({ baseUrl: "https://api.deepseek.com/", apiKey: "sk-test", model: "deepseek-flash" })
      assert.equal(await call("audit instructions", "memory entries"), '{"findings":[]}')

      assert.equal(stub.calls.length, 1)
      assert.equal(stub.calls[0]!.url, "https://api.deepseek.com/chat/completions")
      assert.equal(new Headers(stub.calls[0]!.init.headers).get("authorization"), "Bearer sk-test")
      const body = JSON.parse(String(stub.calls[0]!.init.body))
      assert.equal(body.model, "deepseek-flash")
      assert.equal(body.stream, false)
      assert.deepEqual(body.messages.map((m: any) => m.role), ["system", "user"])
      assert.equal(body.messages[0].content, "audit instructions")
      assert.equal(body.messages[1].content, "memory entries")
    } finally {
      stub.restore()
    }
  })

  it("keeps a base URL that already ends in /chat/completions, and appends otherwise", () => {
    assert.equal(chatCompletionsUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions")
    assert.equal(chatCompletionsUrl("https://x.test/v1///"), "https://x.test/v1/chat/completions")
    assert.equal(chatCompletionsUrl("https://x.test/v1/chat/completions"), "https://x.test/v1/chat/completions")
  })

  it("keeps a query string, drops a fragment, and does not append the path inside a query", () => {
    assert.equal(chatCompletionsUrl("https://x.test/v1?api-version=2"), "https://x.test/v1/chat/completions?api-version=2")
    assert.equal(chatCompletionsUrl("https://x.test/v1#frag"), "https://x.test/v1/chat/completions")
    assert.equal(
      chatCompletionsUrl("https://x.test/v1/chat/completions?api-version=2"),
      "https://x.test/v1/chat/completions?api-version=2",
    )
  })

  it("merges custom headers case-insensitively, so authorization is overridden rather than duplicated", async () => {
    const stub = stubFetch(async () => reply("ok"))
    try {
      const call = createHttpModelCall({
        baseUrl: "https://x.test",
        apiKey: "sk-0123456789",
        model: "m",
        headers: { Authorization: "Token other", "X-Extra": "1" },
      })
      assert.equal(await call("s", "u"), "ok")
      const sent = new Headers(stub.calls[0]!.init.headers)
      assert.equal(sent.get("authorization"), "Token other")
      assert.equal(sent.get("content-type"), "application/json")
      assert.equal(sent.get("x-extra"), "1")
      assert.equal(sent.get("authorization")?.includes(","), false)
    } finally {
      stub.restore()
    }
  })

  it("resolves a {file:...} api key reference", async () => {
    await withDir(async (dir) => {
      const keyFile = path.join(dir, "key")
      await fs.writeFile(keyFile, "sk-from-file\n", "utf8")
      const stub = stubFetch(async () => reply("ok"))
      try {
        const call = createHttpModelCall({ baseUrl: "https://x.test", apiKey: `{file:${keyFile}}`, model: "m" })
        assert.equal(await call("s", "u"), "ok")
        assert.equal(new Headers(stub.calls[0]!.init.headers).get("authorization"), "Bearer sk-from-file")
      } finally {
        stub.restore()
      }
    })
  })

  it("fails loudly on an unreadable key file or an empty env reference", async () => {
    await assert.rejects(() => resolveSecretValue("{file:/nope/missing-key}"), /could not read the api key file/)
    await assert.rejects(() => resolveSecretValue("{env:MEMORY_PLUGIN_TEST_UNSET_VAR}"), /environment variable/)
    assert.equal(await resolveSecretValue("  sk-plain  "), "sk-plain")
  })

  it("surfaces the provider status and body instead of a mystery failure", async () => {
    const stub = stubFetch(async () => new Response('{"error":{"message":"invalid api key"}}', { status: 401 }))
    try {
      const call = createHttpModelCall({ baseUrl: "https://x.test", apiKey: "k", model: "m" })
      await assert.rejects(() => call("s", "u"), /HTTP 401/)
      await assert.rejects(() => call("s", "u"), /invalid api key/)
    } finally {
      stub.restore()
    }
  })

  it("reports a non-JSON or empty completion as a failure", async () => {
    const html = stubFetch(async () => new Response("<html>gateway</html>", { status: 200 }))
    try {
      await assert.rejects(() => createHttpModelCall({ baseUrl: "https://x.test", apiKey: "k", model: "m" })("s", "u"), /non-JSON/)
    } finally {
      html.restore()
    }
    const empty = stubFetch(async () => new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 }))
    try {
      await assert.rejects(() => createHttpModelCall({ baseUrl: "https://x.test", apiKey: "k", model: "m" })("s", "u"), /no text/)
    } finally {
      empty.restore()
    }
  })

  it("refuses a second call while one is unsettled, and times out the first", async () => {
    const stub = stubFetch(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          ;(init.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")))
        }),
    )
    try {
      const call = createHttpModelCall({ baseUrl: "https://x.test", apiKey: "k", model: "m" }, 30)
      const first = call("s", "u").then(
        () => null,
        (err: Error) => err,
      )
      await assert.rejects(() => call("s", "u"), /still running/)
      assert.match(String((await first)?.message), /timed out/)
    } finally {
      stub.restore()
    }
  })

  it("advice names auditProvider when the host credential is rejected", () => {
    const patMessage = 'Provider request failed with HTTP 400: checking third-party user token: bad request: Personal Access Tokens are not supported for this endpoint'
    assert.ok(looksLikeCredentialProblem(patMessage))
    assert.ok(!looksLikeCredentialProblem("fetch failed"))
    assert.ok(!looksLikeCredentialProblem("maximum context length is 65536 tokens"))

    const hostHint = auditFailureHint(patMessage, cfg())
    assert.match(hostHint ?? "", /auditProvider/)

    const directHint = auditFailureHint(patMessage, cfg({
      auditProvider: { baseUrl: "https://api.deepseek.com", apiKey: "k", model: "deepseek-flash" },
    }))
    assert.match(directHint ?? "", /api\.deepseek\.com/)
    assert.match(directHint ?? "", /deepseek-flash/)
  })
})

describe("no secret escapes the direct provider call", () => {
  function stubFetch(handler: (url: string, init: any) => Promise<Response>) {
    const original = globalThis.fetch
    const calls: Array<{ url: string; init: any }> = []
    globalThis.fetch = (async (input: any, init: any) => {
      calls.push({ url: String(input), init })
      return handler(String(input), init)
    }) as typeof fetch
    return {
      calls,
      restore: () => {
        globalThis.fetch = original
      },
    }
  }

  const LIVE_KEY = "sk-live-0123456789abcdefghij"
  const HEADER_SECRET = "hdrtoken-abcdefghijklmnop"

  it("redacts a key the provider echoes back in an error body", async () => {
    const stub = stubFetch(
      async () => new Response(JSON.stringify({ error: { message: `invalid key ${LIVE_KEY}` } }), { status: 401 }),
    )
    try {
      const call = createHttpModelCall({ baseUrl: "https://x.test", apiKey: LIVE_KEY, model: "m" })
      await assert.rejects(
        () => call("s", "u"),
        (err: Error) => {
          assert.ok(!err.message.includes(LIVE_KEY), `key leaked: ${err.message}`)
          assert.match(err.message, /HTTP 401/)
          assert.match(err.message, /\*\*\*/)
          return true
        },
      )
    } finally {
      stub.restore()
    }
  })

  it("redacts a key read from a file and a custom header value", async () => {
    await withDir(async (dir) => {
      const keyFile = path.join(dir, "key")
      await fs.writeFile(keyFile, LIVE_KEY + "\n", "utf8")
      const stub = stubFetch(async () => new Response(`bad ${LIVE_KEY} and ${HEADER_SECRET}`, { status: 500 }))
      try {
        const call = createHttpModelCall({
          baseUrl: "https://x.test",
          apiKey: `{file:${keyFile}}`,
          model: "m",
          headers: { "x-api-key": HEADER_SECRET },
        })
        await assert.rejects(
          () => call("s", "u"),
          (err: Error) => {
            assert.ok(!err.message.includes(LIVE_KEY), "file key leaked")
            assert.ok(!err.message.includes(HEADER_SECRET), "header value leaked")
            return true
          },
        )
      } finally {
        stub.restore()
      }
    })
  })

  it("keeps the key out of the audit log and the audit state file, which feeds the system prompt", async () => {
    await withDir(async (dir) => {
      await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"))
      const logged: string[] = []
      const logger: Logger = {
        async info(line: string) {
          logged.push(line)
        },
        async error(_scope: string, err: unknown) {
          logged.push(String(err))
        },
      }
      const stub = stubFetch(
        async () => new Response(JSON.stringify({ error: { message: `nope ${LIVE_KEY}` } }), { status: 401 }),
      )
      try {
        const provider = { baseUrl: "https://x.test", apiKey: LIVE_KEY, model: "m" }
        const out = await runAudit({
          directory: dir,
          config: cfg({ auditProvider: provider }),
          logger,
          call: createHttpModelCall(provider),
          now: () => NOW,
        })
        assert.equal(out, "failed")
      } finally {
        stub.restore()
      }
      const state = await fs.readFile(path.join(dir, ".memory", "audit-state.json"), "utf8")
      const warning = (await auditWarning(dir, cfg())) ?? ""
      assert.ok(!state.includes(LIVE_KEY), "key persisted in audit-state.json")
      assert.ok(!logged.join("\n").includes(LIVE_KEY), "key written to the plugin log")
      assert.ok(!warning.includes(LIVE_KEY), "key reached the system prompt warning")
      assert.match(state, /HTTP 401/)
    })
  })

  it("treats a 200 with a JSON null body as a clear failure", async () => {
    const stub = stubFetch(async () => new Response("null", { status: 200 }))
    try {
      await assert.rejects(() => createHttpModelCall({ baseUrl: "https://x.test", apiKey: "sk-0123456789", model: "m" })("s", "u"), /no completion object/)
    } finally {
      stub.restore()
    }
  })

  it("points at the configured provider model, not auditModel, when the context overflows", () => {
    const hint = auditFailureHint(
      "maximum context length is 65536 tokens",
      cfg({ auditProvider: { baseUrl: "https://x.test", apiKey: "k", model: "qwen3.7-plus" } }),
    )
    assert.match(hint ?? "", /qwen3\.7-plus/)
    assert.ok(!/"auditModel"/.test(hint ?? ""), "hint still names auditModel in direct mode")
    assert.match(auditFailureHint("maximum context length is 65536 tokens", cfg()) ?? "", /"auditModel"/)
  })
})
