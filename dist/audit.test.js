import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { activeHash, buildAuditPrompt, createAuditScheduler, parseAuditResponse, relationToReason, orderBySimilarity, runAudit, splitIntoBatches, } from "./audit.js";
import { activeDir, listStagedProposals, writeMemoryFile } from "./storage.js";
import { DEFAULT_CONFIG } from "./types.js";
const quietLogger = { async info() { }, async error() { } };
function mem(id, title, body = "body") {
    return { id, title, body, proposedAt: "2026-01-01" };
}
async function withDir(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-audit-"));
    try {
        return await fn(dir);
    }
    finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}
const cfg = (over = {}) => ({ ...DEFAULT_CONFIG, ...over });
const NOW = new Date("2026-11-01T00:00:00Z");
const later = (min) => new Date(NOW.getTime() + min * 60_000);
function findingReply(findings) {
    return async () => JSON.stringify({ findings });
}
async function seed(dir, ...memories) {
    for (const m of memories)
        await writeMemoryFile(activeDir(dir), m);
}
describe("buildAuditPrompt", () => {
    it("lists id, title, tags and body per entry", () => {
        const out = buildAuditPrompt([{ id: "mem-aaaaaaaa", title: "A rule", body: "do X", tags: ["style"] }]);
        assert.match(out, /\[mem-aaaaaaaa\] A rule/);
        assert.match(out, /tags: style/);
        assert.match(out, /do X/);
    });
});
describe("parseAuditResponse", () => {
    const active = [mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"), mem("mem-cccc0003", "C")];
    it("parses valid findings and drops unknown ids and duplicates", () => {
        const findings = parseAuditResponse(JSON.stringify({
            findings: [
                { relation: "duplicate", retire: "mem-aaaa0001", superseded_by: "mem-bbbb0002", reason: "same" },
                { relation: "refinement", retire: "mem-aaaa0001", superseded_by: "mem-cccc0003", reason: "again" },
                { relation: "contradiction", retire: "mem-zzzz9999", reason: "bad id" },
                { relation: "bogus", retire: "mem-bbbb0002", reason: "bad relation" },
            ],
        }), active);
        assert.equal(findings.length, 1);
        assert.equal(findings[0].relation, "duplicate");
        assert.equal(findings[0].retire, "mem-aaaa0001");
        assert.equal(findings[0].supersededBy, "mem-bbbb0002");
    });
    it("returns null for a non-JSON reply", () => {
        assert.equal(parseAuditResponse("I found nothing interesting", active), null);
    });
});
describe("relationToReason", () => {
    it("maps relations onto the retirement vocabulary", () => {
        assert.equal(relationToReason("duplicate"), "duplicate");
        assert.equal(relationToReason("contradiction"), "wrong");
        assert.equal(relationToReason("refinement"), "superseded");
    });
});
describe("activeHash", () => {
    it("is order-independent and changes with content", () => {
        const a = [mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B")];
        const b = [mem("mem-bbbb0002", "B"), mem("mem-aaaa0001", "A")];
        assert.equal(activeHash(a), activeHash(b));
        assert.notEqual(activeHash(a), activeHash([mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "Changed")]));
    });
});
describe("runAudit", () => {
    it("is disabled when backgroundAudit is off", async () => {
        await withDir(async (dir) => {
            await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"));
            const out = await runAudit({ directory: dir, config: cfg({ backgroundAudit: false }), logger: quietLogger, call: findingReply([]), now: () => NOW });
            assert.equal(out, "disabled");
        });
    });
    it("skips when there are fewer than two active memories", async () => {
        await withDir(async (dir) => {
            await seed(dir, mem("mem-aaaa0001", "A"));
            const out = await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call: findingReply([]), now: () => NOW });
            assert.equal(out, "skipped-too-few");
        });
    });
    it("asks the model and emits a retire proposal per finding", async () => {
        await withDir(async (dir) => {
            await seed(dir, mem("mem-aaaa0001", "Old"), mem("mem-bbbb0002", "New"));
            const out = await runAudit({
                directory: dir,
                config: cfg(),
                logger: quietLogger,
                call: findingReply([{ relation: "duplicate", retire: "mem-aaaa0001", superseded_by: "mem-bbbb0002", reason: "same fact" }]),
                now: () => NOW,
            });
            assert.equal(out, "done");
            const staged = await listStagedProposals(dir);
            assert.equal(staged.length, 1);
            assert.equal(staged[0].intent, "retire");
            assert.equal(staged[0].id, "mem-aaaa0001");
            assert.equal(staged[0].retiredReason, "duplicate");
            assert.equal(staged[0].supersededBy, "mem-bbbb0002");
            assert.match(staged[0].source ?? "", /duplicate/);
        });
    });
    it("skips a second run when nothing changed", async () => {
        await withDir(async (dir) => {
            await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"));
            const deps = { directory: dir, config: cfg(), logger: quietLogger, call: findingReply([]), now: () => NOW };
            assert.equal(await runAudit(deps), "done");
            assert.equal(await runAudit(deps), "skipped-unchanged");
        });
    });
    it("honours the minimum interval when memories changed", async () => {
        await withDir(async (dir) => {
            await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"));
            const intervalCfg = cfg({ auditIntervalMinutes: 60 });
            const first = { directory: dir, config: intervalCfg, logger: quietLogger, call: findingReply([]), now: () => NOW };
            assert.equal(await runAudit(first), "done");
            await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B changed"));
            const second = { directory: dir, config: intervalCfg, logger: quietLogger, call: findingReply([]), now: () => later(10) };
            assert.equal(await runAudit(second), "skipped-interval");
            const forced = { directory: dir, config: intervalCfg, logger: quietLogger, call: findingReply([]), now: () => later(10), force: true };
            assert.equal(await runAudit(forced), "done");
        });
    });
    it("does not re-propose a retirement already in staging", async () => {
        await withDir(async (dir) => {
            await seed(dir, mem("mem-aaaa0001", "Old"), mem("mem-bbbb0002", "New"));
            const call = findingReply([{ relation: "duplicate", retire: "mem-aaaa0001", reason: "same" }]);
            assert.equal(await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call, now: () => NOW }), "done");
            assert.equal((await listStagedProposals(dir)).length, 1);
            // Change a memory so the hash differs, then re-run: the finding is the
            // same id, so no new proposal is written.
            await seed(dir, mem("mem-aaaa0001", "Old"), mem("mem-bbbb0002", "New changed"));
            assert.equal(await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call, now: () => later(120) }), "done");
            assert.equal((await listStagedProposals(dir)).length, 1);
        });
    });
    it("discards the verdict when memories change during the call", async () => {
        await withDir(async (dir) => {
            await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"));
            let calls = 0;
            const call = async () => {
                calls++;
                // mutate mid-call so the fresh re-read differs from the pre-call hash
                await writeMemoryFile(activeDir(dir), mem("mem-cccc0003", "C"));
                return JSON.stringify({ findings: [{ relation: "duplicate", retire: "mem-aaaa0001", reason: "x" }] });
            };
            const out = await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call, now: () => NOW });
            assert.equal(out, "discarded-changed");
            assert.equal(calls, 1);
            assert.equal((await listStagedProposals(dir)).length, 0);
        });
    });
    it("treats an unparsable reply as a failure", async () => {
        await withDir(async (dir) => {
            await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"));
            const out = await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call: async () => "not json", now: () => NOW });
            assert.equal(out, "failed");
        });
    });
});
describe("createAuditScheduler", () => {
    it("runs once for a burst of idle events", async () => {
        await withDir(async (dir) => {
            await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"));
            const call = findingReply([{ relation: "duplicate", retire: "mem-aaaa0001", reason: "same" }]);
            const sch = createAuditScheduler({ directory: dir, config: cfg(), logger: quietLogger, call, now: () => NOW }, new Set());
            sch.onSessionIdle("s1");
            sch.onSessionIdle("s2");
            sch.onSessionIdle("s3");
            await sch.settled();
            assert.equal((await listStagedProposals(dir)).length, 1);
        });
    });
    it("runNow bypasses the interval", async () => {
        await withDir(async (dir) => {
            await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"));
            const call = findingReply([]);
            const sch = createAuditScheduler({ directory: dir, config: cfg(), logger: quietLogger, call, now: () => NOW }, new Set());
            assert.equal(await sch.runNow(), "done");
            // change memories, then runNow within the interval still runs (force)
            await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B2"));
            assert.equal(await sch.runNow(), "done");
        });
    });
    it("ignores idle events from audit sessions", async () => {
        await withDir(async (dir) => {
            await seed(dir, mem("mem-aaaa0001", "A"), mem("mem-bbbb0002", "B"));
            let calls = 0;
            const call = async () => {
                calls++;
                return JSON.stringify({ findings: [] });
            };
            const auditSessions = new Set(["audit-1"]);
            const sch = createAuditScheduler({ directory: dir, config: cfg(), logger: quietLogger, call, now: () => NOW }, auditSessions);
            sch.onSessionIdle("audit-1");
            await sch.settled();
            assert.equal(calls, 0);
        });
    });
});
describe("batching", () => {
    const many = (n, body = "x".repeat(200)) => Array.from({ length: n }, (_, i) => mem(`mem-${String(i).padStart(8, "0")}`, `Title ${i}`, body));
    it("returns one batch, in the given order, when everything fits", () => {
        const ms = many(5);
        const out = splitIntoBatches(ms, 1_000_000);
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].map((m) => m.id), ms.map((m) => m.id));
    });
    it("splits by size, keeps every entry, and overlaps consecutive batches", () => {
        const ms = many(30);
        const out = splitIntoBatches(ms, 2_000, 2);
        assert.ok(out.length > 1);
        const seen = new Set(out.flat().map((m) => m.id));
        assert.equal(seen.size, 30);
        for (let i = 1; i < out.length; i++) {
            const prevTail = out[i - 1].slice(-2).map((m) => m.id);
            assert.deepEqual(out[i].slice(0, 2).map((m) => m.id), prevTail);
        }
        for (const b of out)
            assert.ok(b.reduce((n, m) => n + m.id.length + m.title.length + m.body.length + 24, 0) <= 2_000);
    });
    it("gives an oversized entry its own batch instead of dropping it", () => {
        const ms = [mem("mem-aaaa0001", "small"), mem("mem-bbbb0002", "huge", "y".repeat(5_000)), mem("mem-cccc0003", "small too")];
        const out = splitIntoBatches(ms, 1_000, 0);
        assert.equal(new Set(out.flat().map((m) => m.id)).size, 3);
    });
    it("orders related entries next to each other and is deterministic", () => {
        const ms = [
            mem("mem-00000001", "Kingdee API field rules", "kingdee api field name"),
            mem("mem-00000002", "Metabase tooltip wording", "metabase tooltip description"),
            mem("mem-00000003", "Kingdee API sub entity keys", "kingdee api key"),
            mem("mem-00000004", "Metabase dashboard tooltip override", "metabase dashboard tooltip"),
        ];
        const a = orderBySimilarity(ms).map((m) => m.id);
        const b = orderBySimilarity([...ms].reverse()).map((m) => m.id);
        assert.deepEqual(a, b);
        const pos = (id) => a.indexOf(id);
        assert.equal(Math.abs(pos("mem-00000001") - pos("mem-00000003")), 1);
        assert.equal(Math.abs(pos("mem-00000002") - pos("mem-00000004")), 1);
    });
    it("groups Chinese titles by shared characters", () => {
        const ms = [
            mem("mem-00000001", "晶圆库存折算口径", "晶圆 库存"),
            mem("mem-00000002", "委外订单结案日期", "委外 结案"),
            mem("mem-00000003", "晶圆库存分类优先级", "晶圆 库存"),
        ];
        const a = orderBySimilarity(ms).map((m) => m.id);
        assert.equal(Math.abs(a.indexOf("mem-00000001") - a.indexOf("mem-00000003")), 1);
    });
    it("audits a large store in several calls and merges findings across batches", async () => {
        await withDir(async (dir) => {
            const ms = many(12);
            await seed(dir, ...ms);
            const prompts = [];
            const call = async (_sys, prompt) => {
                prompts.push(prompt);
                const ids = [...prompt.matchAll(/\[(mem-\d{8})\]/g)].map((m) => m[1]);
                // every batch reports the same pair it can see; the merged result must hold it once
                if (ids.includes("mem-00000000") && ids.includes("mem-00000001")) {
                    return JSON.stringify({ findings: [{ relation: "duplicate", retire: "mem-00000000", superseded_by: "mem-00000001", reason: "same" }] });
                }
                return JSON.stringify({ findings: [{ relation: "duplicate", retire: ids[0], superseded_by: ids[1], reason: "r" }] });
            };
            const out = await runAudit({ directory: dir, config: cfg({ auditBatchChars: 1_500 }), logger: quietLogger, call, now: () => NOW });
            assert.equal(out, "done");
            assert.ok(prompts.length > 1);
            assert.match(prompts[0], /^Batch 1 of /);
            const staged = await listStagedProposals(dir);
            const ids = staged.map((p) => p.id);
            assert.equal(new Set(ids).size, ids.length);
            assert.ok(ids.length >= 1);
        });
    });
    it("does not cap the number of entries (formerly skipped above 200)", async () => {
        await withDir(async (dir) => {
            await seed(dir, ...many(205, "z"));
            let calls = 0;
            const call = async () => {
                calls++;
                return JSON.stringify({ findings: [] });
            };
            const out = await runAudit({ directory: dir, config: cfg({ auditBatchChars: 100_000 }), logger: quietLogger, call, now: () => NOW });
            assert.equal(out, "done");
            assert.ok(calls >= 1);
        });
    });
    it("fails the whole run without writing proposals or state when one batch fails", async () => {
        await withDir(async (dir) => {
            await seed(dir, ...many(12));
            let n = 0;
            const call = async (_s, prompt) => {
                n++;
                if (n === 2)
                    throw new Error("model down");
                const ids = [...prompt.matchAll(/\[(mem-\d{8})\]/g)].map((m) => m[1]);
                return JSON.stringify({ findings: [{ relation: "duplicate", retire: ids[0], superseded_by: ids[1], reason: "r" }] });
            };
            const out = await runAudit({ directory: dir, config: cfg({ auditBatchChars: 1_500 }), logger: quietLogger, call, now: () => NOW });
            assert.equal(out, "failed");
            assert.equal((await listStagedProposals(dir)).length, 0);
            // not marked as audited: a later run (after the interval) tries again
            const retry = await runAudit({ directory: dir, config: cfg({ auditBatchChars: 1_500 }), logger: quietLogger, call: findingReply([]), now: () => later(5) });
            assert.equal(retry, "done");
        });
    });
});
//# sourceMappingURL=audit.test.js.map