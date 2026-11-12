import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { acquireLock, applyPropose, applyRetire, branchFor, buildPrBody, buildPrCreateArgs, buildPrListArgs, buildPrTitle, defaultBranch, parseRemoteUrl, processStagingOnce } from "./bot.js";
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
// ─── helpers for the git-backed tests below ──────────────────────────────────
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
/** A project repo with a bare remote, an initial commit and (optionally) active memories on main. */
async function setupRepo(root, activeMemories = []) {
    const remote = path.join(root, "remote.git");
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    sh(root, "init", "--bare", "-b", "main", remote);
    sh(repo, "init", "-b", "main");
    sh(repo, "config", "user.email", "t@example.com");
    sh(repo, "config", "user.name", "t");
    await fs.writeFile(path.join(repo, "README.md"), "x");
    for (const m of activeMemories)
        await writeMemoryFile(activeDir(repo), m);
    sh(repo, "add", "-A", "-f", ".");
    sh(repo, "commit", "-m", "init");
    sh(repo, "remote", "add", "origin", remote);
    sh(repo, "push", "-u", "origin", "main");
    return repo;
}
const quiet = () => undefined;
describe("branch names", () => {
    it("keeps memory/<id> for proposals and gives retires their own namespace", () => {
        const base = { id: "mem-aaaaaaaa", title: "t", body: "", proposedAt: "2026-11-12T10:20:30.000Z" };
        assert.equal(branchFor({ ...base, intent: "propose" }), "memory/mem-aaaaaaaa");
        assert.equal(branchFor({ ...base, intent: "retire" }), "memory/retire/mem-aaaaaaaa-20261112102030");
    });
    it("two retire proposals for the same memory get different branches", () => {
        const a = branchFor({ id: "mem-aaaaaaaa", title: "t", body: "", proposedAt: "2026-11-12T10:00:00.000Z", intent: "retire" });
        const b = branchFor({ id: "mem-aaaaaaaa", title: "t", body: "", proposedAt: "2026-11-13T10:00:00.000Z", intent: "retire" });
        assert.notEqual(a, b);
    });
});
describe("gh targeting", () => {
    it("derives owner/repo from common remote URL forms", () => {
        assert.equal(parseRemoteUrl("git@github.com:APT-AEteam/data_platform.git"), "APT-AEteam/data_platform");
        assert.equal(parseRemoteUrl("https://github.com/chncaesar/opencode-plugin-memory"), "chncaesar/opencode-plugin-memory");
        assert.equal(parseRemoteUrl("ssh://git@github.com/o/r.git"), "o/r");
        assert.equal(parseRemoteUrl("git@ghe.example.com:team/proj.git"), "ghe.example.com/team/proj");
        assert.equal(parseRemoteUrl("/tmp/some/remote.git"), undefined);
        assert.equal(parseRemoteUrl("https://github.com/only-one-segment"), undefined);
    });
    it("passes --repo to gh pr create and gh pr list", () => {
        const req = { cwd: "/x", repo: "o/r", base: "main", branch: "memory/mem-aaaaaaaa", title: "T", body: "B" };
        const create = buildPrCreateArgs(req);
        assert.deepEqual(create.slice(0, 4), ["pr", "create", "--repo", "o/r"]);
        assert.ok(create.includes("--head") && create.includes("memory/mem-aaaaaaaa"));
        const list = buildPrListArgs({ cwd: "/x", repo: "o/r", branch: "memory/mem-aaaaaaaa" });
        assert.deepEqual(list.slice(0, 4), ["pr", "list", "--repo", "o/r"]);
        assert.ok(buildPrCreateArgs({ ...req, repo: undefined }).includes("--base"));
        assert.ok(!buildPrCreateArgs({ cwd: "/x", base: "main", branch: "b", title: "T", body: "B" }).includes("--repo"));
    });
});
describe("retire proposals do not collide with the add branch", () => {
    it("retires a memory whose add branch still exists on the remote", async () => {
        await withDir(async (root) => {
            const target = { id: "mem-cccccccc", title: "Old", body: "old body", proposedAt: "2026-01-01", approvedAt: "2026-01-02" };
            const repo = await setupRepo(root, [target]);
            // the add branch from the original PR, kept after merge
            sh(repo, "push", "origin", "main:refs/heads/memory/mem-cccccccc");
            await writeProposal(repo, { id: "mem-cccccccc", title: "Old", body: "", proposedAt: "2026-11-12T10:20:30.000Z", intent: "retire", retiredReason: "stale" });
            const branches = [];
            const res = await processStagingOnce(repo, {
                log: quiet,
                findPr: async () => null,
                openPr: async (r) => {
                    branches.push(r.branch);
                    return "https://example.test/pr/1";
                },
            });
            assert.equal(res.promoted, 1);
            assert.equal(res.recovered, 0);
            assert.deepEqual(branches, ["memory/retire/mem-cccccccc-20261112102030"]);
            assert.match(sh(repo, "ls-remote", "--heads", "origin", "memory/retire/*"), /memory\/retire\/mem-cccccccc-20261112102030/);
        });
    });
});
describe("recovery of an already-pushed proposal", () => {
    it("opens the missing PR when the branch was pushed but the PR step had failed", async () => {
        await withDir(async (root) => {
            const repo = await setupRepo(root);
            sh(repo, "push", "origin", "main:refs/heads/memory/mem-dddddddd");
            await writeProposal(repo, { id: "mem-dddddddd", title: "D", body: "d", proposedAt: "2026-01-01", intent: "propose" });
            let opened = 0;
            const res = await processStagingOnce(repo, {
                log: quiet,
                findPr: async () => null,
                openPr: async () => {
                    opened++;
                    return "https://example.test/pr/9";
                },
            });
            assert.equal(opened, 1);
            assert.equal(res.recovered, 1);
            assert.equal(res.failed, 0);
            assert.deepEqual(res.prs, ["https://example.test/pr/9"]);
            await assert.rejects(fs.access(path.join(stagingDir(repo), "mem-dddddddd.md")));
        });
    });
    it("only drops the staged file when a PR already exists", async () => {
        await withDir(async (root) => {
            const repo = await setupRepo(root);
            sh(repo, "push", "origin", "main:refs/heads/memory/mem-eeeeeeee");
            await writeProposal(repo, { id: "mem-eeeeeeee", title: "E", body: "e", proposedAt: "2026-01-01", intent: "propose" });
            const res = await processStagingOnce(repo, {
                log: quiet,
                findPr: async () => "https://example.test/pr/3",
                openPr: async () => {
                    throw new Error("must not open a second PR");
                },
            });
            assert.equal(res.recovered, 1);
            assert.deepEqual(res.prs, ["https://example.test/pr/3"]);
            await assert.rejects(fs.access(path.join(stagingDir(repo), "mem-eeeeeeee.md")));
        });
    });
    it("a push-then-PR-failure is retried and finishes on the next run", async () => {
        await withDir(async (root) => {
            const repo = await setupRepo(root);
            await writeProposal(repo, { id: "mem-ffffffff", title: "F", body: "f", proposedAt: "2026-01-01", intent: "propose" });
            const first = await processStagingOnce(repo, {
                log: quiet,
                findPr: async () => null,
                openPr: async () => {
                    throw new Error("gh rate limited");
                },
            });
            assert.equal(first.failed, 1);
            await fs.access(path.join(stagingDir(repo), "mem-ffffffff.md")); // still staged
            assert.match(sh(repo, "ls-remote", "--heads", "origin", "memory/mem-ffffffff"), /mem-ffffffff/); // but pushed
            const second = await processStagingOnce(repo, { log: quiet, findPr: async () => null, openPr: async () => "https://example.test/pr/4" });
            assert.equal(second.recovered, 1);
            assert.equal(second.failed, 0);
            await assert.rejects(fs.access(path.join(stagingDir(repo), "mem-ffffffff.md")));
        });
    });
});
describe("stale worktrees", () => {
    it("removes a worktree left by a crashed run and still publishes", async () => {
        await withDir(async (root) => {
            const repo = await setupRepo(root);
            const leftover = await fs.mkdtemp(path.join(os.tmpdir(), "memory-bot-"));
            sh(repo, "worktree", "add", "-b", "memory/mem-gggggggg", leftover, "main"); // crashed run: branch checked out there
            await writeProposal(repo, { id: "mem-gggggggg", title: "G", body: "g", proposedAt: "2026-01-01", intent: "propose" });
            const res = await processStagingOnce(repo, { log: quiet, findPr: async () => null, openPr: async () => "https://example.test/pr/5" });
            assert.equal(res.promoted, 1);
            assert.equal(res.failed, 0);
            assert.ok(!sh(repo, "worktree", "list").includes("memory-bot-"));
            await assert.rejects(fs.access(leftover));
        });
    });
});
describe("single-run lock", () => {
    const lockFile = (repo) => path.join(repo, ".memory", "bot.lock");
    it("a second concurrent run reports busy and the first still finishes", async () => {
        await withDir(async (root) => {
            const repo = await setupRepo(root);
            await writeProposal(repo, { id: "mem-hhhhhhhh", title: "H", body: "h", proposedAt: "2026-01-01", intent: "propose" });
            let release;
            const gate = new Promise((r) => (release = r));
            let entered;
            const inside = new Promise((r) => (entered = r));
            const first = processStagingOnce(repo, {
                log: quiet,
                findPr: async () => null,
                openPr: async () => {
                    entered();
                    await gate;
                    return "https://example.test/pr/6";
                },
            });
            await inside;
            const second = await processStagingOnce(repo, { log: quiet, findPr: async () => null, openPr: async () => "x" });
            assert.equal(second.busy, true);
            release();
            assert.equal((await first).promoted, 1);
            await assert.rejects(fs.access(lockFile(repo)));
        });
    });
    it("never exposes an empty or partial lock file", async () => {
        await withDir(async (root) => {
            const repo = await setupRepo(root);
            const rel = await acquireLock(repo);
            assert.ok(rel);
            const content = await fs.readFile(lockFile(repo), "utf8");
            assert.match(content, /^\d+:\d+:[0-9a-f]+$/);
            assert.equal(await acquireLock(repo), null); // live and fresh: busy
            await rel();
            await assert.rejects(fs.access(lockFile(repo)));
        });
    });
    it("takes over a lock whose process is dead or that is older than the stale limit", async () => {
        await withDir(async (root) => {
            const repo = await setupRepo(root);
            await fs.mkdir(path.join(repo, ".memory"), { recursive: true });
            await fs.writeFile(lockFile(repo), `99999999:${Date.now()}:aa`, "utf8"); // dead pid
            const a = await acquireLock(repo);
            assert.ok(a);
            await a();
            await fs.writeFile(lockFile(repo), `${process.pid}:${Date.now() - 31 * 60_000}:bb`, "utf8"); // live pid, too old
            const b = await acquireLock(repo);
            assert.ok(b);
            await b();
            await fs.writeFile(lockFile(repo), String(process.pid), "utf8"); // old pid-only format
            const c = await acquireLock(repo);
            assert.ok(c);
            await c();
        });
    });
    it("releases the lock when setup fails before any proposal is handled", async () => {
        await withDir(async (root) => {
            const notARepo = path.join(root, "plain");
            await fs.mkdir(notARepo);
            await writeProposal(notARepo, { id: "mem-iiiiiiii", title: "I", body: "i", proposedAt: "2026-01-01", intent: "propose" });
            await assert.rejects(processStagingOnce(notARepo, { log: quiet, findPr: async () => null, openPr: async () => "x" }));
            await assert.rejects(fs.access(lockFile(notARepo)));
        });
    });
});
//# sourceMappingURL=bot.test.js.map