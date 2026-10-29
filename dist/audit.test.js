import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { addEntry, writeStore, readStore } from "./storage.js";
import { readReviewState, writeReviewState, emptyReviewState, hashActive, hashEntries } from "./review.js";
import { buildAuditPrompt, createAuditScheduler, createSdkModelCall, parseAuditResponse, runAudit, } from "./audit.js";
import { DEFAULT_CONFIG } from "./types.js";
const quietLogger = { async info() { }, async error() { } };
function mkStore(...titles) {
    let s = { entries: [], nextSeq: 1 };
    for (const t of titles)
        s = addEntry(s, t, `body of ${t}`).store;
    return s;
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
describe("parseAuditResponse", () => {
    const s = mkStore("A", "B", "C");
    it("parses a clean reply", () => {
        const f = parseAuditResponse('{"findings":[{"ids":["MEM-002","MEM-001"],"relation":"duplicate","reason":"same"}]}', s);
        assert.equal(f.length, 1);
        assert.deepEqual(f[0].ids, ["MEM-001", "MEM-002"]);
        assert.equal(f[0].relation, "duplicate");
    });
    it("tolerates prose and code fences around the JSON", () => {
        const f = parseAuditResponse('Sure!\n```json\n{"findings":[{"ids":["MEM-001","MEM-003"],"relation":"contradiction","reason":"x {y}"}]}\n```', s);
        assert.equal(f.length, 1);
        assert.equal(f[0].reason, "x {y}");
    });
    it("drops unknown ids, bad relations, single ids and duplicate pairs", () => {
        const f = parseAuditResponse(JSON.stringify({
            findings: [
                { ids: ["MEM-001", "MEM-099"], relation: "duplicate", reason: "" },
                { ids: ["MEM-001", "MEM-002"], relation: "similar", reason: "" },
                { ids: ["MEM-001"], relation: "duplicate", reason: "" },
                { ids: ["MEM-001", "MEM-002"], relation: "refinement", reason: "ok" },
                { ids: ["MEM-002", "MEM-001"], relation: "duplicate", reason: "dup of pair" },
            ],
        }), s);
        assert.equal(f.length, 1);
        assert.equal(f[0].relation, "refinement");
    });
    it("returns null for non-audit output and [] for an empty result", () => {
        assert.equal(parseAuditResponse("no json here", s), null);
        assert.equal(parseAuditResponse('{"other":1}', s), null);
        assert.deepEqual(parseAuditResponse('{"findings":[]}', s), []);
    });
    it("does not accept archived entries", () => {
        const st = mkStore("A", "B");
        st.entries[1] = { ...st.entries[1], archived: true };
        assert.deepEqual(parseAuditResponse('{"findings":[{"ids":["MEM-001","MEM-002"],"relation":"duplicate","reason":""}]}', st), []);
    });
    it("keeps every valid finding — there is no count cap", () => {
        const titles = Array.from({ length: 50 }, (_, i) => `entry ${i + 1}`);
        const st = mkStore(...titles);
        const findings = Array.from({ length: 25 }, (_, i) => ({
            ids: [`MEM-${String(i * 2 + 1).padStart(3, "0")}`, `MEM-${String(i * 2 + 2).padStart(3, "0")}`],
            relation: "duplicate",
            reason: `pair ${i + 1}`,
        }));
        const out = parseAuditResponse(JSON.stringify({ findings }), st);
        assert.equal(out.length, 25);
        assert.equal(out[24].reason, "pair 25");
    });
});
describe("buildAuditPrompt", () => {
    it("lists ids, titles and the full body with no truncation", () => {
        const s = mkStore("Alpha");
        const body = "x".repeat(2000);
        s.entries[0] = { ...s.entries[0], content: body };
        const p = buildAuditPrompt(s.entries);
        assert.match(p, /\[MEM-001\] Alpha/);
        assert.ok(p.includes(body), "the whole body is sent");
        assert.ok(p.length > 2000);
    });
});
describe("runAudit", () => {
    const reply = '{"findings":[{"ids":["MEM-001","MEM-002"],"relation":"duplicate","reason":"same rule"}]}';
    it("stores findings and records the audited hash", async () => {
        await withDir(async (dir) => {
            const s = mkStore("A", "B");
            await writeStore(dir, s);
            let calls = 0;
            const out = await runAudit({
                directory: dir,
                config: cfg(),
                logger: quietLogger,
                call: async () => { calls++; return reply; },
            });
            assert.equal(out, "done");
            assert.equal(calls, 1);
            const st = await readReviewState(dir);
            assert.equal(st.findings.length, 1);
            assert.equal(st.lastHash, hashActive(s));
            assert.ok(st.lastAuditAt);
        });
    });
    it("skips when nothing changed since the last audit", async () => {
        await withDir(async (dir) => {
            await writeStore(dir, mkStore("A", "B"));
            let calls = 0;
            const deps = {
                directory: dir,
                config: cfg({ auditIntervalMinutes: 0.0001 }),
                logger: quietLogger,
                call: (async () => { calls++; return reply; }),
            };
            assert.equal(await runAudit(deps), "done");
            assert.equal(await runAudit(deps), "skipped-unchanged");
            assert.equal(calls, 1);
        });
    });
    it("skips inside the minimum interval even when memories changed", async () => {
        await withDir(async (dir) => {
            await writeStore(dir, mkStore("A", "B"));
            let calls = 0;
            const deps = {
                directory: dir,
                config: cfg(),
                logger: quietLogger,
                call: (async () => { calls++; return reply; }),
            };
            assert.equal(await runAudit(deps), "done");
            await writeStore(dir, mkStore("A", "B", "C"));
            assert.equal(await runAudit(deps), "skipped-interval");
            assert.equal(calls, 1);
        });
    });
    it("re-audits after the interval has passed", async () => {
        await withDir(async (dir) => {
            await writeStore(dir, mkStore("A", "B"));
            let calls = 0;
            let t = Date.parse("2026-10-01T00:00:00Z");
            const deps = {
                directory: dir,
                config: cfg(),
                logger: quietLogger,
                call: (async () => { calls++; return reply; }),
                now: () => new Date(t),
            };
            assert.equal(await runAudit(deps), "done");
            await writeStore(dir, mkStore("A", "B", "C"));
            t += 61 * 60_000;
            assert.equal(await runAudit(deps), "done");
            assert.equal(calls, 2);
        });
    });
    it("does nothing when disabled or with fewer than two active entries", async () => {
        await withDir(async (dir) => {
            await writeStore(dir, mkStore("A", "B"));
            let calls = 0;
            const call = (async () => { calls++; return reply; });
            assert.equal(await runAudit({ directory: dir, config: cfg({ backgroundAudit: false }), logger: quietLogger, call }), "disabled");
            await writeStore(dir, mkStore("A"));
            assert.equal(await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call }), "skipped-too-few");
            assert.equal(calls, 0);
        });
    });
    it("clears stale findings when entries drop below two", async () => {
        await withDir(async (dir) => {
            await writeStore(dir, mkStore("A", "B"));
            const call = (async () => reply);
            await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call });
            await writeStore(dir, mkStore("A"));
            await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call });
            assert.equal((await readReviewState(dir)).findings.length, 0);
        });
    });
    it("skips when there are too many entries", async () => {
        await withDir(async (dir) => {
            let s = { entries: [], nextSeq: 1 };
            for (let i = 0; i < 201; i++)
                s = addEntry(s, `T${i}`, "x").store;
            await writeStore(dir, s);
            let calls = 0;
            const out = await runAudit({
                directory: dir,
                config: cfg(),
                logger: quietLogger,
                call: (async () => { calls++; return reply; }),
            });
            assert.equal(out, "skipped-too-many");
            assert.equal(calls, 0);
        });
    });
    it("a failing model call does not throw, keeps lastHash, and rate-limits retries", async () => {
        await withDir(async (dir) => {
            await writeStore(dir, mkStore("A", "B"));
            let calls = 0;
            const deps = {
                directory: dir,
                config: cfg(),
                logger: quietLogger,
                call: (async () => { calls++; throw new Error("boom"); }),
            };
            assert.equal(await runAudit(deps), "failed");
            const st = await readReviewState(dir);
            assert.equal(st.lastHash, "");
            assert.ok(st.lastAuditAt);
            assert.equal(await runAudit(deps), "skipped-interval");
            assert.equal(calls, 1);
        });
    });
    it("an unparsable reply counts as failed and stores nothing", async () => {
        await withDir(async (dir) => {
            await writeStore(dir, mkStore("A", "B"));
            const out = await runAudit({
                directory: dir,
                config: cfg(),
                logger: quietLogger,
                call: async () => "I cannot do that",
            });
            assert.equal(out, "failed");
            assert.equal((await readReviewState(dir)).findings.length, 0);
        });
    });
    it("discards the verdict when memories change during the model call", async () => {
        await withDir(async (dir) => {
            await writeStore(dir, mkStore("A", "B"));
            const call = async () => {
                await writeStore(dir, mkStore("A", "B", "C"));
                return reply;
            };
            assert.equal(await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call }), "discarded-changed");
            const st = await readReviewState(dir);
            assert.equal(st.findings.length, 0);
            assert.equal(st.lastHash, "");
        });
    });
    it("keeps a still-valid dismissal written while the audit was running", async () => {
        await withDir(async (dir) => {
            const s = mkStore("A", "B");
            await writeStore(dir, s);
            const hash = hashEntries(s.entries);
            const call = async () => {
                await writeReviewState(dir, { ...emptyReviewState(), dismissed: [{ key: "MEM-001+MEM-002", hash }] });
                return reply;
            };
            await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call });
            const st = await readReviewState(dir);
            assert.equal(st.findings.length, 1);
            assert.deepEqual(st.dismissed, [{ key: "MEM-001+MEM-002", hash }]);
        });
    });
    it("never modifies MEMORY.md", async () => {
        await withDir(async (dir) => {
            const s = mkStore("A", "B");
            await writeStore(dir, s);
            const before = await fs.readFile(path.join(dir, ".opencode/memory/MEMORY.md"), "utf8");
            await runAudit({ directory: dir, config: cfg(), logger: quietLogger, call: async () => reply });
            assert.equal(await fs.readFile(path.join(dir, ".opencode/memory/MEMORY.md"), "utf8"), before);
            assert.equal((await readStore(dir)).entries.length, 2);
        });
    });
});
describe("createAuditScheduler", () => {
    it("runs one audit for a burst of idle events and ignores audit sessions", async () => {
        await withDir(async (dir) => {
            await writeStore(dir, mkStore("A", "B"));
            let calls = 0;
            const auditSessions = new Set(["audit-1"]);
            const call = async () => {
                calls++;
                await new Promise((r) => setTimeout(r, 20));
                return '{"findings":[]}';
            };
            const sch = createAuditScheduler({ directory: dir, config: cfg(), logger: quietLogger, call }, auditSessions);
            sch.onSessionIdle("audit-1");
            sch.onSessionIdle("s1");
            sch.onSessionIdle("s2");
            sch.onSessionIdle("s3");
            await sch.settled();
            assert.equal(calls, 1);
        });
    });
    it("does nothing when disabled", async () => {
        await withDir(async (dir) => {
            await writeStore(dir, mkStore("A", "B"));
            let calls = 0;
            const sch = createAuditScheduler({
                directory: dir,
                config: cfg({ backgroundAudit: false }),
                logger: quietLogger,
                call: async () => { calls++; return "{}"; },
            }, new Set());
            sch.onSessionIdle("s1");
            await sch.settled();
            assert.equal(calls, 0);
        });
    });
});
describe("createSdkModelCall", () => {
    function fakeClient(opts = {}) {
        const log = [];
        const seen = {};
        const client = {
            session: {
                async create() { log.push("create"); return { data: { id: "sess-1" } }; },
                async prompt(o) {
                    log.push("prompt");
                    seen.body = o.body;
                    if (opts.promptFails)
                        return { error: { message: "nope" } };
                    if (opts.providerError) {
                        return {
                            data: {
                                info: { error: { name: "APIError", data: { message: "Payment Required: no balance" } } },
                                parts: [],
                            },
                        };
                    }
                    return {
                        data: {
                            parts: [
                                { type: "text", text: '{"findings":' },
                                { type: "reasoning", text: "ignored" },
                                { type: "text", text: "[]}" },
                            ],
                        },
                    };
                },
                async delete() { log.push("delete"); return {}; },
            },
        };
        return { client, log, seen };
    }
    it("creates a session under the audit agent, joins text parts, deletes it", async () => {
        const { client, log, seen } = fakeClient();
        const sessions = new Set();
        const call = createSdkModelCall(client, "/proj", sessions);
        assert.equal(await call("sys", "prompt"), '{"findings":\n[]}');
        assert.deepEqual(log, ["create", "prompt", "delete"]);
        assert.equal(seen.body["agent"], "memory-audit");
        assert.equal(seen.body["system"], "sys");
        assert.equal(seen.body["tools"], undefined);
        assert.equal(seen.body["model"], undefined);
        assert.ok(sessions.has("sess-1"));
    });
    it("honours a custom agent name", async () => {
        const { client, seen } = fakeClient();
        await createSdkModelCall(client, "/proj", new Set(), "other-agent")("s", "p");
        assert.equal(seen.body["agent"], "other-agent");
    });
    it("still deletes the session when the prompt fails", async () => {
        const { client, log } = fakeClient({ promptFails: true });
        await assert.rejects(createSdkModelCall(client, "/proj", new Set())("s", "p"));
        assert.deepEqual(log, ["create", "prompt", "delete"]);
    });
    it("surfaces a provider error carried in the assistant message", async () => {
        const { client, log } = fakeClient({ providerError: true });
        await assert.rejects(createSdkModelCall(client, "/proj", new Set())("s", "p"), /Payment Required: no balance/);
        assert.deepEqual(log, ["create", "prompt", "delete"]);
    });
});
describe("force and runNow", () => {
    const reply = '{"findings":[]}';
    it("force bypasses the interval but not the unchanged-hash check", async () => {
        await withDir(async (dir) => {
            await writeStore(dir, mkStore("A", "B"));
            let calls = 0;
            const deps = {
                directory: dir,
                config: cfg(),
                logger: quietLogger,
                call: (async () => { calls++; return reply; }),
            };
            assert.equal(await runAudit(deps), "done");
            await writeStore(dir, mkStore("A", "B", "C"));
            assert.equal(await runAudit(deps), "skipped-interval");
            assert.equal(await runAudit({ ...deps, force: true }), "done");
            assert.equal(await runAudit({ ...deps, force: true }), "skipped-unchanged");
            assert.equal(calls, 2);
        });
    });
    it("runNow waits for an in-flight audit, then runs a forced one", async () => {
        await withDir(async (dir) => {
            await writeStore(dir, mkStore("A", "B"));
            const calls = [];
            const call = async () => {
                calls.push("call");
                await new Promise((r) => setTimeout(r, 30));
                return reply;
            };
            const sch = createAuditScheduler({ directory: dir, config: cfg(), logger: quietLogger, call }, new Set());
            sch.onSessionIdle("s1");
            await writeStore(dir, mkStore("A", "B", "C"));
            assert.equal(await sch.runNow(), "done");
            // first run audited the old two entries, the forced run audited three
            assert.equal(calls.length, 2);
        });
    });
    it("runNow reports skipped-unchanged instead of calling the model", async () => {
        await withDir(async (dir) => {
            await writeStore(dir, mkStore("A", "B"));
            let calls = 0;
            const sch = createAuditScheduler({
                directory: dir,
                config: cfg(),
                logger: quietLogger,
                call: async () => { calls++; return reply; },
            }, new Set());
            assert.equal(await sch.runNow(), "done");
            assert.equal(await sch.runNow(), "skipped-unchanged");
            assert.equal(calls, 1);
        });
    });
});
//# sourceMappingURL=audit.test.js.map