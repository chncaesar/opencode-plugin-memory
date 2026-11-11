import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { activeHash, buildAuditPrompt, createAuditScheduler, parseAuditResponse, relationToReason, runAudit, } from "./audit.js";
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
//# sourceMappingURL=audit.test.js.map