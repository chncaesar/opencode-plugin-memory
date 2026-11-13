import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { createV2ModelCall, pendingPublishNotice, resolveConfig, server, setup } from "./plugin.js";
import defaultExport from "./index.js";
import { activeDir, listActiveMemories, stagingDir, writeMemoryFile, writeProposal } from "./storage.js";
async function withDir(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-index-"));
    try {
        return await fn(dir);
    }
    finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}
function fakeInput(directory) {
    return { directory, project: {}, worktree: directory, serverUrl: new URL("http://localhost"), $: {} };
}
async function seedStale(dir) {
    await writeMemoryFile(activeDir(dir), {
        id: "mem-aaaa0001",
        title: "Ancient rule",
        body: "old",
        proposedAt: "2020-01-01",
        approvedAt: "2020-01-01",
    });
}
describe("resolveConfig", () => {
    it("auditBatchChars defaults to 400000 and can be overridden", () => {
        assert.equal(resolveConfig().auditBatchChars, 400_000);
        assert.equal(resolveConfig({ auditBatchChars: 50_000 }).auditBatchChars, 50_000);
        assert.equal(resolveConfig({ auditBatchChars: -1 }).auditBatchChars, 400_000);
    });
    it("accepts overrides and ignores junk", () => {
        const c = resolveConfig({ maxSummaryChars: 3000, staleDays: 7, backgroundAudit: false, enableLog: false });
        assert.equal(c.maxSummaryChars, 3000);
        assert.equal(c.staleDays, 7);
        assert.equal(c.backgroundAudit, false);
        assert.equal(c.enableLog, false);
        assert.equal(resolveConfig({ staleDays: -5 }).staleDays, 90);
    });
});
describe("V2 model call (timeout, abort signal and the no-overlap guard)", () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    it("passes the prompt, the model and an AbortSignal, and returns the text", async () => {
        let seen = {};
        const call = createV2ModelCall(async (input, opts) => {
            seen = { prompt: input.prompt, model: input.model, signal: opts?.signal };
            return { text: "ok" };
        }, { providerID: "deepseek", id: "deepseek-flash" }, 1000);
        assert.equal(await call("SYS", "USER"), "ok");
        assert.equal(seen.prompt, "SYS\n\nUSER");
        assert.deepEqual(seen.model, { providerID: "deepseek", id: "deepseek-flash" });
        assert.ok(seen.signal && !seen.signal.aborted);
    });
    it("on timeout it rejects and signals abort; a host that honours the signal settles and the next call proceeds", async () => {
        let signal;
        let first = true;
        const call = createV2ModelCall((_input, opts) => {
            signal = opts?.signal;
            if (!first)
                return Promise.resolve({ text: "second" });
            first = false;
            return new Promise((_res, rej) => opts?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
        }, undefined, 20);
        await assert.rejects(call("s", "p"), /timed out after/);
        assert.equal(signal?.aborted, true);
        await wait(5); // let the aborted request settle
        assert.equal(await call("s", "p"), "second");
    });
    it("if the host ignores the signal (as OpenCode 2.2.7 does), the next call fails fast instead of starting a concurrent request", async () => {
        let started = 0;
        const call = createV2ModelCall(() => {
            started++;
            return new Promise(() => { }); // never settles, ignores the signal
        }, undefined, 20);
        await assert.rejects(call("s", "p"), /timed out/);
        await assert.rejects(call("s", "p"), /still running/);
        assert.equal(started, 1);
    });
    it("a request that fails after the timeout does not raise an unhandled rejection", async () => {
        const call = createV2ModelCall((_i, opts) => new Promise((_r, rej) => opts?.signal?.addEventListener("abort", () => setTimeout(() => rej(new Error("late")), 5))), undefined, 10);
        await assert.rejects(call("s", "p"), /timed out/);
        await wait(30); // would crash the test process on an unhandled rejection
    });
});
describe("pending publish notice", () => {
    it("is null with nothing staged, and lists staged proposals with the memory_publish instruction", async () => {
        await withDir(async (dir) => {
            assert.equal(await pendingPublishNotice(dir), null);
            await writeProposal(dir, { id: "mem-aaaa0001", title: "Retire me", body: "", proposedAt: "2026-11-12", intent: "retire", retiredReason: "duplicate" });
            await writeProposal(dir, { id: "mem-bbbb0002", title: "New rule", body: "b", proposedAt: "2026-11-12", intent: "propose" });
            const n = (await pendingPublishNotice(dir)) ?? "";
            assert.match(n, /2 staged memory proposals have no pull request yet/);
            assert.match(n, /\[mem-aaaa0001\] Retire me \(retire\)/);
            assert.match(n, /memory_publish/);
        });
    });
    it("reaches the system prompt, and is gone once nothing is staged", async () => {
        await withDir(async (dir) => {
            await writeProposal(dir, { id: "mem-aaaa0001", title: "Retire me", body: "", proposedAt: "2026-11-12", intent: "retire", retiredReason: "stale" });
            const hooks = await server(fakeInput(dir));
            const out = { system: [] };
            await hooks["experimental.chat.system.transform"]({ sessionID: "ses_x" }, out);
            assert.match(out.system.join("\n"), /Call memory_publish/);
            await fs.rm(stagingDir(dir), { recursive: true, force: true });
            const out2 = { system: [] };
            await hooks["experimental.chat.system.transform"]({ sessionID: "ses_x" }, out2);
            assert.ok(!/Call memory_publish/.test(out2.system.join("\n")));
        });
    });
});
describe("plugin entry", () => {
    it("injecting the index in a directory without memories creates no memory/ folder", async () => {
        await withDir(async (dir) => {
            const hooks = await server(fakeInput(dir));
            const out = { system: [] };
            await hooks["experimental.chat.system.transform"]({ sessionID: "ses_x" }, out);
            assert.match(out.system.join("\n"), /no active memories/);
            await assert.rejects(fs.access(path.join(dir, "memory")));
        });
    });
    it("registers six tools, the event hook and the system transform hook", async () => {
        await withDir(async (dir) => {
            const hooks = await server(fakeInput(dir));
            assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), [
                "memory_delete",
                "memory_propose",
                "memory_publish",
                "memory_read",
                "memory_review",
                "memory_update",
            ]);
            assert.equal(typeof hooks.event, "function");
            assert.equal(typeof hooks["experimental.chat.system.transform"], "function");
            assert.equal(typeof hooks.config, "function");
        });
    });
    it("system transform bootstraps the summary and injects the index plus policy", async () => {
        await withDir(async (dir) => {
            await seedStale(dir);
            const hooks = await server(fakeInput(dir));
            const out = { system: [] };
            await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, out);
            const text = out.system.join("\n");
            assert.match(text, /Ancient rule/);
            assert.match(text, /PR-gated project memory system/);
            assert.match(text, /memory_propose/);
        });
    });
    it("config hook registers the restricted audit agent", async () => {
        await withDir(async (dir) => {
            const hooks = await server(fakeInput(dir));
            const cfg = { agent: {} };
            await hooks.config(cfg);
            assert.ok(cfg.agent["memory-audit"]);
        });
    });
    it("migrates a legacy store on startup", async () => {
        await withDir(async (dir) => {
            await fs.mkdir(path.join(dir, ".opencode/memory"), { recursive: true });
            await fs.writeFile(path.join(dir, ".opencode/memory/MEMORY.md"), "# OpenCode Memory\n<!-- nextSeq: 2 -->\n\n## Active\n\n### [MEM-001] Legacy rule\n- added: 2026-01-01\nOld body.\n\n## Archived\n", "utf8");
            await server(fakeInput(dir));
            const migrated = await listActiveMemories(dir);
            assert.ok(migrated.some((m) => m.title === "Legacy rule"));
        });
    });
});
describe("V2 entry", () => {
    function mockCtx(dir, options) {
        const tools = {};
        const hooks = {};
        const disposed = [];
        const ctx = {
            location: { directory: dir },
            ...(options ? { options } : {}),
            tool: {
                async transform(fn) {
                    fn({ add: (t) => { tools[t.name] = t; } });
                    return { dispose: async () => { disposed.push("tool"); } };
                },
            },
            session: {
                async hook(name, cb) {
                    hooks[name] = cb;
                    return { dispose: async () => { disposed.push(name); } };
                },
            },
        };
        return { ctx, tools, hooks, disposed };
    }
    it("default export is { id, setup } and keeps server for V1", () => {
        assert.equal(typeof defaultExport.id, "string");
        assert.equal(typeof defaultExport.setup, "function");
        assert.equal(typeof defaultExport.server, "function");
    });
    it("setup registers six tools that execute, injects context, and disposes", async () => {
        await withDir(async (dir) => {
            await seedStale(dir);
            const m = mockCtx(dir);
            const cleanup = await setup(m.ctx);
            assert.deepEqual(Object.keys(m.tools).sort(), [
                "memory_delete", "memory_propose", "memory_publish", "memory_read", "memory_review", "memory_update",
            ]);
            const added = await m.tools["memory_propose"].execute({ title: "Rule three", content: "three" });
            assert.match(added.content, /Proposed \[mem-/);
            const event = { sessionID: "s1", system: [] };
            await m.hooks["context"](event);
            assert.equal(event.system.length, 1);
            assert.equal(event.system[0].type, "text");
            assert.match(event.system[0].text, /Ancient rule/);
            await cleanup();
            assert.deepEqual(m.disposed.sort(), ["context", "experimental.idle", "tool"]);
        });
    });
    it("does not register the idle hook when the audit is disabled", async () => {
        await withDir(async (dir) => {
            const m = mockCtx(dir, { backgroundAudit: false });
            await setup(m.ctx);
            assert.equal(m.hooks["experimental.idle"], undefined);
        });
    });
});
//# sourceMappingURL=index.test.js.map