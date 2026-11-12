import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { applyPropose, applyRetire, buildPrBody, buildPrTitle, defaultBranch, processStagingOnce } from "./bot.js";
import { activeDir, listActiveMemories, listRetiredMemories, stagingDir, writeMemoryFile, writeProposal } from "./storage.js";
async function withDir(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-bot-"));
    try {
        return await fn(dir);
    }
    finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}
function active(id, title, body = "content") {
    return { id, title, body, proposedAt: "2026-01-01", approvedAt: "2026-01-01" };
}
describe("applyPropose", () => {
    it("promotes a proposal into active/ and strips the intent field", async () => {
        await withDir(async (dir) => {
            const proposal = {
                id: "mem-aaaa0001",
                title: "New rule",
                body: "The body.",
                author: "alice",
                proposedAt: "2026-01-01",
                intent: "propose",
            };
            await applyPropose(dir, proposal);
            const activeMemories = await listActiveMemories(dir);
            assert.equal(activeMemories.length, 1);
            assert.equal(activeMemories[0].id, "mem-aaaa0001");
            assert.equal(activeMemories[0].body, "The body.");
            assert.equal(activeMemories[0].intent, undefined);
        });
    });
    it("moves superseded targets to retired/ with superseded_by links", async () => {
        await withDir(async (dir) => {
            await writeMemoryFile(activeDir(dir), active("mem-old00001", "Old rule"));
            const proposal = {
                id: "mem-new00002",
                title: "New rule",
                body: "b",
                supersedes: ["mem-old00001"],
                intent: "propose",
            };
            await applyPropose(dir, proposal);
            assert.equal((await listActiveMemories(dir)).length, 1);
            const retired = await listRetiredMemories(dir);
            assert.equal(retired.length, 1);
            assert.equal(retired[0].id, "mem-old00001");
            assert.equal(retired[0].supersededBy, "mem-new00002");
            assert.equal(retired[0].retiredReason, "superseded");
            assert.ok(retired[0].retiredAt);
        });
    });
    it("is idempotent — re-running does not duplicate retired files", async () => {
        await withDir(async (dir) => {
            await writeMemoryFile(activeDir(dir), active("mem-old00001", "Old"));
            const proposal = { id: "mem-new00002", title: "New", body: "b", supersedes: ["mem-old00001"], intent: "propose" };
            await applyPropose(dir, proposal);
            await applyPropose(dir, proposal);
            assert.equal((await listActiveMemories(dir)).length, 1);
            assert.equal((await listRetiredMemories(dir)).length, 1);
        });
    });
    it("does not remove the staged file (orchestration does that)", async () => {
        await withDir(async (dir) => {
            const proposal = { id: "mem-aaaa0001", title: "T", body: "b", intent: "propose" };
            await writeProposal(dir, proposal);
            await applyPropose(dir, proposal);
            await fs.access(path.join(stagingDir(dir), "mem-aaaa0001.md"));
        });
    });
});
describe("applyRetire", () => {
    it("moves an active memory to retired/ with the reason", async () => {
        await withDir(async (dir) => {
            await writeMemoryFile(activeDir(dir), active("mem-aaaa0001", "To remove"));
            const staged = { id: "mem-aaaa0001", title: "To remove", body: "", intent: "retire", retiredReason: "wrong" };
            await applyRetire(dir, staged);
            assert.equal((await listActiveMemories(dir)).length, 0);
            const retired = await listRetiredMemories(dir);
            assert.equal(retired.length, 1);
            assert.equal(retired[0].retiredReason, "wrong");
            assert.ok(retired[0].retiredAt);
        });
    });
    it("is a no-op when the active memory is already gone", async () => {
        await withDir(async (dir) => {
            const staged = { id: "mem-aaaa0001", title: "Gone", body: "", intent: "retire", retiredReason: "stale" };
            const changed = await applyRetire(dir, staged);
            assert.deepEqual(changed, []);
            assert.equal((await listRetiredMemories(dir)).length, 0);
        });
    });
});
describe("PR template", () => {
    it("titles a propose and a retire distinctly", () => {
        assert.equal(buildPrTitle({ id: "mem-aaaa0001", title: "Use int for money", body: "", intent: "propose" }), "memory: Use int for money");
        assert.equal(buildPrTitle({ id: "mem-aaaa0001", title: "X", body: "", intent: "retire" }), "memory: retire mem-aaaa0001");
    });
    it("body lists the checklist and retire reason", () => {
        const body = buildPrBody({ id: "mem-aaaa0001", title: "X", body: "", intent: "retire", retiredReason: "stale" });
        assert.match(body, /retire \(reason: stale\)/);
        assert.match(body, /memory checklist/);
        assert.match(body, /Not a duplicate/);
    });
});
describe("defaultBranch", () => {
    it("returns main when not in a repo", async () => {
        await withDir(async (dir) => {
            assert.equal(await defaultBranch(dir), "main");
        });
    });
});
describe("processStagingOnce (worktree isolation)", () => {
    const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    it("opens a branch per proposal without touching the developer checkout", async () => {
        await withDir(async (root) => {
            const remote = path.join(root, "remote.git");
            const repo = path.join(root, "repo");
            await fs.mkdir(repo);
            sh(root, "init", "--bare", "-b", "main", remote);
            sh(repo, "init", "-b", "main");
            sh(repo, "config", "user.email", "t@example.com");
            sh(repo, "config", "user.name", "t");
            await fs.writeFile(path.join(repo, "README.md"), "x");
            sh(repo, "add", ".");
            sh(repo, "commit", "-m", "init");
            sh(repo, "remote", "add", "origin", remote);
            sh(repo, "push", "-u", "origin", "main");
            // The developer is on another branch with uncommitted work.
            sh(repo, "checkout", "-b", "feature");
            await fs.writeFile(path.join(repo, "wip.txt"), "uncommitted");
            await writeProposal(repo, { id: "mem-aaaaaaaa", title: "A", body: "body a", proposedAt: "2026-01-01", intent: "propose" });
            const prs = [];
            const res = await processStagingOnce(repo, {
                log: () => undefined,
                openPr: async (r) => {
                    prs.push(r.branch);
                    return `https://example.test/pr/${prs.length}`;
                },
            });
            assert.equal(res.promoted, 1);
            assert.equal(res.failed, 0);
            assert.deepEqual(res.prs, ["https://example.test/pr/1"]);
            assert.deepEqual(prs, ["memory/mem-aaaaaaaa"]);
            assert.equal(sh(repo, "rev-parse", "--abbrev-ref", "HEAD"), "feature");
            assert.equal(await fs.readFile(path.join(repo, "wip.txt"), "utf8"), "uncommitted");
            assert.match(sh(repo, "ls-remote", "origin", "memory/mem-aaaaaaaa"), /refs\/heads\/memory\/mem-aaaaaaaa/);
            assert.equal(sh(repo, "worktree", "list").split("\n").length, 1);
            await assert.rejects(fs.access(path.join(stagingDir(repo), "mem-aaaaaaaa.md")));
            await assert.rejects(fs.access(path.join(activeDir(repo), "mem-aaaaaaaa.md"))); // active/ only exists on the PR branch
        });
    });
    it("keeps a proposal staged when the PR step fails, and retries it cleanly", async () => {
        await withDir(async (root) => {
            const remote = path.join(root, "remote.git");
            const repo = path.join(root, "repo");
            await fs.mkdir(repo);
            sh(root, "init", "--bare", "-b", "main", remote);
            sh(repo, "init", "-b", "main");
            sh(repo, "config", "user.email", "t@example.com");
            sh(repo, "config", "user.name", "t");
            await fs.writeFile(path.join(repo, "README.md"), "x");
            sh(repo, "add", ".");
            sh(repo, "commit", "-m", "init");
            sh(repo, "remote", "add", "origin", remote);
            sh(repo, "push", "-u", "origin", "main");
            await writeProposal(repo, { id: "mem-bbbbbbbb", title: "B", body: "body b", proposedAt: "2026-01-01", intent: "propose" });
            const failed = await processStagingOnce(repo, {
                log: () => undefined,
                openPr: async () => {
                    throw new Error("gh down");
                },
            });
            assert.equal(failed.failed, 1);
            await fs.access(path.join(stagingDir(repo), "mem-bbbbbbbb.md"));
        });
    });
});
//# sourceMappingURL=bot.test.js.map