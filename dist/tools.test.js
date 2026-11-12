import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { createMemoryTools, mapRetireReason } from "./tools.js";
import { runAudit } from "./audit.js";
import { activeDir, listActiveMemories, listStagedProposals, writeMemoryFile } from "./storage.js";
import { DEFAULT_CONFIG } from "./types.js";
const lines = [];
const logger = {
    async info(a, d = "") { lines.push(`${a} ${d}`); },
    async error(a, e) { lines.push(`ERR ${a} ${String(e)}`); },
};
const tools = createMemoryTools(DEFAULT_CONFIG, logger);
async function run(tool, args, dir) {
    const t = tool;
    const r = await t.execute(args, { directory: dir });
    return typeof r === "string" ? { title: "", output: r } : r;
}
async function withDir(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-tools-"));
    try {
        return await fn(dir);
    }
    finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}
function activeMemory(id, title, body, approvedAt = "2026-01-01") {
    return { id, title, body, proposedAt: "2026-01-01", approvedAt };
}
async function seed(dir, ...memories) {
    for (const m of memories)
        await writeMemoryFile(activeDir(dir), m);
}
describe("mapRetireReason", () => {
    it("maps free text onto the fixed vocabulary, defaulting to stale", () => {
        assert.equal(mapRetireReason("this is wrong now"), "wrong");
        assert.equal(mapRetireReason("a duplicate of another"), "duplicate");
        assert.equal(mapRetireReason("useless"), "useless");
        assert.equal(mapRetireReason("replaced by X"), "superseded");
        assert.equal(mapRetireReason("outdated"), "stale");
        assert.equal(mapRetireReason(undefined), "stale");
        assert.equal(mapRetireReason("random words"), "stale");
    });
});
describe("memory_propose", () => {
    it("writes a staging proposal and does not touch active", async () => {
        await withDir(async (dir) => {
            const r = await run(tools.memory_propose, { title: "New rule", content: "Body text." }, dir);
            assert.match(r.title, /Memory proposed/);
            assert.match(r.output, /Proposed \[mem-/);
            assert.match(r.output, /proposal only/);
            const staged = await listStagedProposals(dir);
            assert.equal(staged.length, 1);
            assert.equal(staged[0].title, "New rule");
            assert.equal(staged[0].intent, "propose");
            assert.equal(staged[0].body, "Body text.");
            assert.equal((await listActiveMemories(dir)).length, 0);
        });
    });
    it("rejects content containing a credential and writes nothing", async () => {
        await withDir(async (dir) => {
            const token = `ghp_${"a".repeat(36)}`;
            const r = await run(tools.memory_propose, { title: "leak", content: `my token is ${token}` }, dir);
            assert.equal(r.title, "Memory not proposed");
            assert.match(r.output, /GitHub token/);
            assert.doesNotMatch(r.output, new RegExp(token));
            assert.equal((await listStagedProposals(dir)).length, 0);
        });
    });
    it("skips when a duplicate title already exists in active", async () => {
        await withDir(async (dir) => {
            await seed(dir, activeMemory("mem-aaaa0001", "Use int for money", "cents"));
            const r = await run(tools.memory_propose, { title: "Use int for money", content: "different body" }, dir);
            assert.equal(r.title, "Memory not proposed");
            assert.match(r.output, /duplicate/);
            assert.equal((await listStagedProposals(dir)).length, 0);
        });
    });
    it("skips when a duplicate content already exists in staging", async () => {
        await withDir(async (dir) => {
            await seed(dir, activeMemory("mem-aaaa0001", "Other title", "same body text"));
            const r = await run(tools.memory_propose, { title: "Another title", content: "same body text" }, dir);
            assert.equal(r.title, "Memory not proposed");
            assert.equal((await listStagedProposals(dir)).length, 0);
        });
    });
    it("rejects supersedes ids that are not active", async () => {
        await withDir(async (dir) => {
            await seed(dir, activeMemory("mem-aaaa0001", "A", "a"));
            const r = await run(tools.memory_propose, { title: "New", content: "n", supersedes: ["mem-bbbb0002"] }, dir);
            assert.equal(r.title, "Memory not proposed");
            assert.match(r.output, /mem-bbbb0002/);
            assert.equal((await listStagedProposals(dir)).length, 0);
        });
    });
    it("records supersedes on a proposal when the ids are active", async () => {
        await withDir(async (dir) => {
            await seed(dir, activeMemory("mem-aaaa0001", "Old", "old"));
            await run(tools.memory_propose, { title: "New", content: "n", supersedes: ["mem-aaaa0001"] }, dir);
            const staged = await listStagedProposals(dir);
            assert.deepEqual(staged[0].supersedes, ["mem-aaaa0001"]);
        });
    });
    it("returns a clean message when staging is not writable", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-tool-ro-"));
        try {
            await fs.chmod(dir, 0o555);
            const r = await run(tools.memory_propose, { title: "t", content: "c" }, dir);
            assert.equal(r.title, "Memory not proposed");
            assert.match(r.output, /not writable/);
        }
        finally {
            await fs.chmod(dir, 0o755);
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});
describe("memory_update", () => {
    it("proposes a supersession and leaves the target active", async () => {
        await withDir(async (dir) => {
            await seed(dir, activeMemory("mem-aaaa0001", "Old title", "old body"));
            const r = await run(tools.memory_update, { id: "mem-aaaa0001", content: "new body" }, dir);
            assert.match(r.title, /Memory update proposed/);
            const staged = await listStagedProposals(dir);
            assert.equal(staged.length, 1);
            assert.deepEqual(staged[0].supersedes, ["mem-aaaa0001"]);
            assert.equal(staged[0].body, "new body");
            assert.equal(staged[0].title, "Old title");
            // target is untouched
            const active = await listActiveMemories(dir);
            assert.equal(active.length, 1);
            assert.equal(active[0].body, "old body");
        });
    });
    it("reports an unknown id", async () => {
        await withDir(async (dir) => {
            const r = await run(tools.memory_update, { id: "mem-zzzz0009", content: "x" }, dir);
            assert.equal(r.title, "Memory not found");
        });
    });
});
describe("memory_delete", () => {
    it("proposes a retirement and leaves the target active", async () => {
        await withDir(async (dir) => {
            await seed(dir, activeMemory("mem-aaaa0001", "To remove", "body"));
            const r = await run(tools.memory_delete, { id: "mem-aaaa0001", reason: "this is wrong now" }, dir);
            assert.match(r.title, /retirement proposed/);
            const staged = await listStagedProposals(dir);
            assert.equal(staged.length, 1);
            assert.equal(staged[0].intent, "retire");
            assert.equal(staged[0].id, "mem-aaaa0001");
            assert.equal(staged[0].retiredReason, "wrong");
            assert.equal(staged[0].body, "");
            assert.equal((await listActiveMemories(dir)).length, 1);
        });
    });
    it("reports an unknown id", async () => {
        await withDir(async (dir) => {
            assert.equal((await run(tools.memory_delete, { id: "mem-zzzz0009" }, dir)).title, "Memory not found");
        });
    });
});
describe("memory_read", () => {
    it("shows active bodies, pending proposals, and retired only on request", async () => {
        await withDir(async (dir) => {
            await seed(dir, activeMemory("mem-aaaa0001", "Active one", "active body"));
            await run(tools.memory_propose, { title: "Pending", content: "pending body" }, dir);
            await run(tools.memory_delete, { id: "mem-aaaa0001" }, dir);
            const out = await run(tools.memory_read, {}, dir);
            assert.match(out.output, /Active one/);
            assert.match(out.output, /active body/);
            assert.match(out.output, /Pending/);
            assert.match(out.output, /not yet merged/);
            // retired only with include_retired (nothing is retired yet here)
            const withRetired = await run(tools.memory_read, { include_retired: true }, dir);
            assert.match(withRetired.output, /Retired memories/);
        });
    });
    it("filters by query", async () => {
        await withDir(async (dir) => {
            await seed(dir, activeMemory("mem-aaaa0001", "Alpha", "a"), activeMemory("mem-bbbb0002", "Beta", "b"));
            const out = await run(tools.memory_read, { query: "alpha" }, dir);
            assert.match(out.output, /Alpha/);
            assert.doesNotMatch(out.output, /Beta/);
        });
    });
});
describe("memory_review", () => {
    it("lists active, pending, and aging entries, read-only", async () => {
        await withDir(async (dir) => {
            await seed(dir, activeMemory("mem-aaaa0001", "Fresh", "f", "2026-11-01"), activeMemory("mem-bbbb0002", "Ancient", "a", "2020-01-01"));
            await run(tools.memory_propose, { title: "Pending", content: "p" }, dir);
            const r = await run(tools.memory_review, {}, dir);
            assert.match(r.output, /Active memories/);
            assert.match(r.output, /\[mem-aaaa0001\] Fresh/);
            assert.match(r.output, /Pending proposals — not yet merged/);
            assert.match(r.output, /Aging memories/);
            assert.match(r.output, /Ancient/);
        });
    });
    it("lists retired entries on request", async () => {
        await withDir(async (dir) => {
            await seed(dir, activeMemory("mem-aaaa0001", "Active", "a"));
            await run(tools.memory_delete, { id: "mem-aaaa0001", reason: "stale" }, dir);
            const r = await run(tools.memory_review, { include_retired: true }, dir);
            // nothing has actually moved to retired/ yet (it is a proposal)
            assert.match(r.output, /Retired memories/);
            assert.doesNotMatch(r.output, /Active \(retired\)/);
        });
    });
});
describe("memory_review shows the background audit", () => {
    it("reports an audit failure with the fix for a context-window error", async () => {
        await withDir(async (dir) => {
            await writeMemoryFile(activeDir(dir), { id: "mem-aaaa0001", title: "A", body: "a", proposedAt: "2026-01-01" });
            await writeMemoryFile(activeDir(dir), { id: "mem-bbbb0002", title: "B", body: "b", proposedAt: "2026-01-01" });
            await runAudit({
                directory: dir, config: DEFAULT_CONFIG, logger,
                call: async () => { throw new Error("This model's maximum context length is 65536 tokens"); },
            });
            const r = await run(tools.memory_review, {}, dir);
            assert.match(r.output, /## Background audit/);
            assert.match(r.output, /FAILED/);
            assert.match(r.output, /maximum context length/);
            assert.match(r.output, /auditBatchChars/);
        });
    });
    it("says the audit has not run yet in a fresh project", async () => {
        await withDir(async (dir) => {
            const r = await run(tools.memory_review, {}, dir);
            assert.match(r.output, /## Background audit\nNot run yet/);
        });
    });
});
//# sourceMappingURL=tools.test.js.map