import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { acquireLock, applyPropose, applyRetire, branchFor, buildPrBody, buildPrCreateArgs, buildPrListArgs, buildPrTitle, defaultBranch, parseRemoteUrl, processStagingOnce, resolveCliStoreDir, resolveCliStoreTarget } from "./bot.js";
import { activeDir, listActiveMemories, listRetiredMemories, retiredDir, stagingDir, writeMemoryFile, writeProposal } from "./storage.js";
import { publishWarning, readPublishState, recordPublishFailure } from "./publishState.js";
async function withDir(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-bot-"));
    try {
        return await fn(dir);
    }
    finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}
it("prints CLI help when launched through an npm-style bin symlink", { skip: process.platform === "win32" }, async () => {
    await withDir(async (dir) => {
        const bin = path.join(dir, "opencode-memory-bot");
        await fs.symlink(fileURLToPath(new URL("./bot.js", import.meta.url)), bin);
        const run = spawnSync(process.execPath, [bin, "--help"], { cwd: dir, encoding: "utf8" });
        assert.ifError(run.error);
        assert.equal(run.status, 0, run.stderr);
        assert.match(run.stderr, /Usage:/);
    });
});
describe("resolveCliStoreDir", () => {
    /** A clone with a main branch pushed to a bare remote: a developer checkout. */
    async function developerRepo(root) {
        const remote = path.join(root, "remote.git");
        const dev = path.join(root, "dev");
        const home = path.join(root, "home");
        execFileSync("git", ["init", "-q", "--bare", remote], { cwd: root });
        execFileSync("git", ["clone", "-q", remote, dev], { cwd: root });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dev });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: dev });
        await fs.writeFile(path.join(dev, "README.md"), "readme\n", "utf8");
        execFileSync("git", ["add", "-A"], { cwd: dev });
        execFileSync("git", ["commit", "-qm", "init"], { cwd: dev });
        execFileSync("git", ["branch", "-M", "main"], { cwd: dev });
        execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: dev });
        return { dev, home };
    }
    it("resolves a developer checkout to its managed project store when --dir is omitted", async () => {
        await withDir(async (root) => {
            const { dev, home } = await developerRepo(root);
            const resolved = await resolveCliStoreTarget(dev, undefined, { home, forceRefresh: true });
            assert.equal(resolved.source, "managed");
            assert.notEqual(resolved.root, dev);
            assert.ok(resolved.root.startsWith(home + path.sep));
            assert.ok(resolved.repository);
        });
    });
    it("resolveCliStoreDir still returns just the store root", async () => {
        await withDir(async (root) => {
            const { dev, home } = await developerRepo(root);
            const resolved = await resolveCliStoreDir(dev, undefined, { home, forceRefresh: true });
            assert.equal(typeof resolved, "string");
            assert.notEqual(resolved, dev);
            assert.ok(resolved.startsWith(home + path.sep));
        });
    });
    it("keeps a plain directory as its own store, as the plugin does for non-Git projects", async () => {
        await withDir(async (root) => {
            const dir = path.join(root, "plain");
            await fs.mkdir(dir);
            const resolved = await resolveCliStoreTarget(dir, undefined, { home: path.join(root, "home") });
            assert.deepEqual({ root: resolved.root, source: resolved.source }, { root: dir, source: "project-dir" });
        });
    });
    it("accepts an explicit --dir that is an existing store root, exactly as given", async () => {
        await withDir(async (root) => {
            const store = path.join(root, "global-store");
            await fs.mkdir(path.join(store, "memory"), { recursive: true });
            const resolved = await resolveCliStoreTarget(root, store);
            assert.deepEqual({ root: resolved.root, source: resolved.source }, { root: store, source: "explicit" });
            // The compatibility accessor agrees.
            assert.equal(await resolveCliStoreDir(root, store), store);
        });
    });
    it("refuses an explicit --dir that does not exist", async () => {
        await withDir(async (root) => {
            await assert.rejects(resolveCliStoreTarget(root, path.join(root, "missing")), /does not exist/);
        });
    });
    it("refuses an explicit --dir that holds neither .memory/ nor memory/", async () => {
        await withDir(async (root) => {
            const empty = path.join(root, "not-a-store");
            await fs.mkdir(empty);
            await assert.rejects(resolveCliStoreTarget(root, empty), /neither \.memory\/ nor memory\//);
        });
    });
    it("does not remap an explicit --dir that is a developer checkout with a managed store", async () => {
        await withDir(async (root) => {
            const { dev, home } = await developerRepo(root);
            const managed = await resolveCliStoreTarget(dev, undefined, { home, forceRefresh: true });
            assert.equal(managed.source, "managed");
            // A checkout that also holds a store layout is still used exactly as given.
            await fs.mkdir(path.join(dev, ".memory", "staging"), { recursive: true });
            const explicit = await resolveCliStoreTarget(dev, dev, { home });
            assert.deepEqual({ root: explicit.root, source: explicit.source }, { root: dev, source: "explicit" });
        });
    });
    it("names the store it checked instead of reporting an unqualified 'no staged proposals'", async () => {
        await withDir(async (dir) => {
            await fs.mkdir(path.join(dir, ".memory", "staging"), { recursive: true });
            const run = spawnSync(process.execPath, [fileURLToPath(new URL("./bot.js", import.meta.url)), "once"], {
                cwd: dir,
                encoding: "utf8",
            });
            assert.ifError(run.error);
            assert.equal(run.status, 0, run.stderr);
            assert.match(run.stdout, /no staged proposals \(checked /);
            assert.match(run.stdout, /not a Git project/);
            assert.ok(run.stdout.includes(path.basename(dir)), run.stdout);
        });
    });
});
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
        // The merge gate must ask whether the artifact already states the rule.
        assert.match(body, /Not already stated/);
        // A retire PR must not claim it makes the memory active.
        assert.match(body, /Merging this PR retires the memory/);
        assert.doesNotMatch(body, /makes the memory active/);
    });
    it("marks a graduated rule as implemented by the artifact", () => {
        const body = buildPrBody({ id: "mem-aaaa0001", title: "X", body: "", intent: "retire", retiredReason: "implemented" });
        assert.match(body, /retire \(reason: implemented\)/);
        assert.match(body, /\*\*Graduated\*\*/);
        assert.match(body, /a second copy would drift/);
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
async function setupRepo(root, activeMemories = [], name = "repo") {
    const remote = path.join(root, "remote.git");
    const repo = path.join(root, name);
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
describe("failure isolation between proposals", () => {
    it("a proposal that fails at the commit step leaves no trace in the next proposal's commit", async () => {
        await withDir(async (root) => {
            const repo = await setupRepo(root);
            const remote = path.join(root, "remote.git");
            // Synthetic, network-free commit failure: a pre-commit hook (shared with the
            // bot's worktree) refuses only proposal A's commit, and only after A's files
            // have already been written and staged. The hook matches on an exact staged
            // set, so a leaked A file would make B's commit pass the hook instead — which
            // is what makes the diff assertion below able to catch the leak.
            const hook = path.join(repo, ".git", "hooks", "pre-commit");
            await fs.writeFile(hook, [
                "#!/bin/sh",
                'staged=$(git diff --cached --name-only -- memory)',
                'if [ "$staged" = "memory/active/mem-aaaa0001.md" ]; then',
                '  echo "synthetic commit failure" >&2',
                "  exit 1",
                "fi",
                "exit 0",
                "",
            ].join("\n"), "utf8");
            await fs.chmod(hook, 0o755);
            await writeProposal(repo, { id: "mem-aaaa0001", title: "A", body: "body a", proposedAt: "2026-01-01", intent: "propose" });
            await writeProposal(repo, { id: "mem-bbbb0002", title: "B", body: "body b", proposedAt: "2026-01-01", intent: "propose" });
            const logs = [];
            const prs = [];
            const res = await processStagingOnce(repo, {
                log: (line) => logs.push(line),
                findPr: async () => null,
                openPr: async (r) => {
                    prs.push(r.branch);
                    return `https://example.test/pr/${prs.length}`;
                },
            });
            // A failed after its filesystem changes were applied; B still succeeded.
            assert.equal(res.failed, 1);
            assert.equal(res.promoted, 1);
            assert.deepEqual(prs, ["memory/mem-bbbb0002"]);
            assert.ok(logs.some((line) => line.includes("failed mem-aaaa0001")), logs.join(" | "));
            // A stays staged for the next run; B was published and dropped.
            await fs.access(path.join(stagingDir(repo), "mem-aaaa0001.md"));
            await assert.rejects(fs.access(path.join(stagingDir(repo), "mem-bbbb0002.md")));
            // A never reached the remote.
            assert.equal(sh(repo, "ls-remote", "--heads", "origin", "memory/mem-aaaa0001"), "");
            // B's actual committed diff carries B and only B — no leaked A file.
            assert.deepEqual(sh(remote, "diff", "--name-only", "main", "memory/mem-bbbb0002").split("\n"), [
                "memory/active/mem-bbbb0002.md",
            ]);
            const committed = sh(remote, "show", "memory/mem-bbbb0002:memory/active/mem-bbbb0002.md");
            assert.match(committed, /body b/);
            assert.doesNotMatch(committed, /mem-aaaa0001/);
        });
    });
});
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
describe("worktree ownership", () => {
    it("publishes from a checkout whose directory name starts with the bot's temp prefix", async () => {
        await withDir(async (root) => {
            const repo = await setupRepo(root, [], "memory-bot-primary");
            sh(repo, "checkout", "-b", "feature");
            await fs.writeFile(path.join(repo, "wip.txt"), "uncommitted work");
            await writeProposal(repo, { id: "mem-jjjjjjjj", title: "J", body: "j", proposedAt: "2026-01-01", intent: "propose" });
            const res = await processStagingOnce(repo, { log: quiet, findPr: async () => null, openPr: async () => "https://example.test/pr/7" });
            assert.equal(res.promoted, 1);
            assert.equal(res.failed, 0);
            // The checkout itself is untouched: same branch, same edits, no extra worktree.
            assert.equal(sh(repo, "rev-parse", "--abbrev-ref", "HEAD"), "feature");
            assert.equal(await fs.readFile(path.join(repo, "wip.txt"), "utf8"), "uncommitted work");
            assert.equal(sh(repo, "worktree", "list").split("\n").length, 1);
        });
    });
    it("leaves an unrelated linked worktree with the same prefix and uncommitted changes alone", async () => {
        await withDir(async (root) => {
            const repo = await setupRepo(root);
            const unrelated = path.join(root, "memory-bot-scratch");
            sh(repo, "worktree", "add", "-b", "scratch", unrelated, "main");
            await fs.writeFile(path.join(unrelated, "notes.txt"), "user work");
            await writeProposal(repo, { id: "mem-kkkkkkkk", title: "K", body: "k", proposedAt: "2026-01-01", intent: "propose" });
            try {
                const res = await processStagingOnce(repo, { log: quiet, findPr: async () => null, openPr: async () => "https://example.test/pr/8" });
                assert.equal(res.promoted, 1);
                assert.equal(res.failed, 0);
                assert.equal(await fs.readFile(path.join(unrelated, "notes.txt"), "utf8"), "user work");
                assert.match(sh(repo, "worktree", "list"), /memory-bot-scratch/);
            }
            finally {
                sh(repo, "worktree", "remove", "--force", unrelated);
            }
        });
    });
    it("preserves the current run's worktree when Git refuses to remove it", async () => {
        await withDir(async (root) => {
            const repo = await setupRepo(root);
            await writeProposal(repo, { id: "mem-llllllll", title: "L", body: "l", proposedAt: "2026-01-01", intent: "propose" });
            const logs = [];
            let temp = "";
            try {
                const res = await processStagingOnce(repo, {
                    log: (line) => logs.push(line),
                    findPr: async () => null,
                    openPr: async (r) => {
                        temp = r.cwd;
                        // A locked worktree makes `git worktree remove --force` refuse.
                        execFileSync("git", ["worktree", "lock", "."], { cwd: r.cwd });
                        return "https://example.test/pr/9";
                    },
                });
                assert.equal(res.promoted, 1);
                assert.ok(temp, "the run used a worktree");
                await fs.access(temp); // still on disk
                assert.match(sh(repo, "worktree", "list"), new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
                assert.ok(logs.some((line) => line.includes("could not remove worktree") && line.includes(temp)), `expected a preservation log line, got: ${logs.join(" | ")}`);
            }
            finally {
                if (temp) {
                    try {
                        sh(repo, "worktree", "remove", "--force", "--force", temp);
                    }
                    catch {
                        // fixture teardown only
                    }
                    await fs.rm(temp, { recursive: true, force: true });
                }
            }
        });
    });
    it("publishes even when a preserved crashed-run worktree still holds the local proposal branch", async () => {
        await withDir(async (root) => {
            const repo = await setupRepo(root);
            const leftover = path.join(root, "memory-bot-crashed");
            sh(repo, "worktree", "add", "-b", "memory/mem-mmmmmmmm", leftover, "main");
            await writeProposal(repo, { id: "mem-mmmmmmmm", title: "M", body: "m", proposedAt: "2026-01-01", intent: "propose" });
            try {
                const res = await processStagingOnce(repo, { log: quiet, findPr: async () => null, openPr: async () => "https://example.test/pr/10" });
                assert.equal(res.promoted, 1);
                assert.equal(res.failed, 0);
                assert.match(sh(repo, "ls-remote", "--heads", "origin", "memory/mem-mmmmmmmm"), /memory\/mem-mmmmmmmm/);
                await fs.access(leftover); // preserved, not deleted
            }
            finally {
                sh(repo, "worktree", "remove", "--force", leftover);
            }
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
describe("filesystem boundary", () => {
    const stagedFile = (repo, name) => path.join(stagingDir(repo), name);
    it("applyPropose refuses a symlinked active file and leaves its target alone", async () => {
        await withDir(async (dir) => {
            const sentinel = path.join(dir, "sentinel.txt");
            await fs.writeFile(sentinel, "keep me");
            await fs.mkdir(activeDir(dir), { recursive: true });
            await fs.symlink(sentinel, path.join(activeDir(dir), "mem-aaaa0001.md"));
            await assert.rejects(applyPropose(dir, { id: "mem-aaaa0001", title: "T", body: "b", intent: "propose" }), /not a regular file/);
            assert.equal(await fs.readFile(sentinel, "utf8"), "keep me");
            assert.equal((await fs.lstat(path.join(activeDir(dir), "mem-aaaa0001.md"))).isSymbolicLink(), true);
        });
    });
    it("applyPropose refuses a symlinked active directory before writing", async () => {
        await withDir(async (dir) => {
            const elsewhere = path.join(dir, "elsewhere");
            await fs.mkdir(elsewhere);
            await fs.mkdir(path.join(dir, "memory"));
            await fs.symlink(elsewhere, activeDir(dir));
            await assert.rejects(applyPropose(dir, { id: "mem-aaaa0001", title: "T", body: "b", intent: "propose" }), /not a real directory/);
            assert.deepEqual(await fs.readdir(elsewhere), []);
        });
    });
    it("applyPropose refuses an invalid supersedes reference before writing", async () => {
        await withDir(async (dir) => {
            await assert.rejects(applyPropose(dir, { id: "mem-aaaa0001", title: "T", body: "b", supersedes: ["not-a-memory-id"], intent: "propose" }), /is not a memory id/);
            await assert.rejects(fs.access(path.join(activeDir(dir), "mem-aaaa0001.md")));
        });
    });
    it("applyRetire refuses a symlinked active memory and leaves it in place", async () => {
        await withDir(async (dir) => {
            const sentinel = path.join(dir, "sentinel.txt");
            await fs.writeFile(sentinel, "keep me");
            await fs.mkdir(activeDir(dir), { recursive: true });
            await fs.symlink(sentinel, path.join(activeDir(dir), "mem-aaaa0001.md"));
            await assert.rejects(applyRetire(dir, { id: "mem-aaaa0001", title: "T", body: "", intent: "retire", retiredReason: "stale" }), /not a regular file/);
            assert.equal(await fs.readFile(sentinel, "utf8"), "keep me");
            await assert.rejects(fs.access(path.join(retiredDir(dir), "mem-aaaa0001.md")));
        });
    });
    it("rejects a symlinked staged proposal without opening a PR or taking the lock", async () => {
        await withDir(async (dir) => {
            const sentinel = path.join(dir, "sentinel.txt");
            await fs.writeFile(sentinel, "keep me");
            await fs.mkdir(stagingDir(dir), { recursive: true });
            const link = stagedFile(dir, "mem-aaaa0001.md");
            await fs.symlink(sentinel, link);
            let opened = 0;
            const res = await processStagingOnce(dir, {
                log: quiet,
                openPr: async () => {
                    opened++;
                    return "https://example.test/pr/1";
                },
            });
            assert.equal(res.failed, 1);
            assert.equal(res.promoted, 0);
            assert.equal(opened, 0);
            assert.equal(await fs.readFile(sentinel, "utf8"), "keep me");
            assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
            await assert.rejects(fs.access(path.join(dir, ".memory", "bot.lock")));
        });
    });
    it("rejects a directory that claims to be a staged proposal", async () => {
        await withDir(async (dir) => {
            const bogus = stagedFile(dir, "mem-aaaa0001.md");
            await fs.mkdir(bogus, { recursive: true });
            const res = await processStagingOnce(dir, { log: quiet, openPr: async () => "https://example.test/pr/1" });
            assert.equal(res.failed, 1);
            assert.equal(res.promoted, 0);
            assert.equal((await fs.lstat(bogus)).isDirectory(), true);
        });
    });
    it("rejects a staged file whose frontmatter id disagrees with its name", async () => {
        await withDir(async (dir) => {
            const file = stagedFile(dir, "mem-aaaa0001.md");
            await fs.mkdir(stagingDir(dir), { recursive: true });
            await fs.writeFile(file, "---\nid: mem-bbbb0002\ntitle: X\nintent: propose\n---\nbody\n");
            const res = await processStagingOnce(dir, { log: quiet, openPr: async () => "https://example.test/pr/1" });
            assert.equal(res.failed, 1);
            assert.equal(res.promoted, 0);
            await fs.access(file); // preserved for a human
        });
    });
    it("rejects a staged proposal with an invalid supersedes reference", async () => {
        await withDir(async (dir) => {
            const file = stagedFile(dir, "mem-aaaa0001.md");
            await fs.mkdir(stagingDir(dir), { recursive: true });
            await fs.writeFile(file, "---\nid: mem-aaaa0001\ntitle: X\nintent: propose\nsupersedes:\n  - not-a-memory-id\n---\nbody\n");
            const res = await processStagingOnce(dir, { log: quiet, openPr: async () => "https://example.test/pr/1" });
            assert.equal(res.failed, 1);
            assert.equal(res.promoted, 0);
            await fs.access(file);
        });
    });
    it("refuses a symlinked staging directory before taking the lock", async () => {
        await withDir(async (dir) => {
            const elsewhere = path.join(dir, "elsewhere");
            await fs.mkdir(elsewhere);
            await fs.writeFile(path.join(elsewhere, "mem-aaaa0001.md"), "---\nid: mem-aaaa0001\ntitle: X\nintent: propose\n---\nbody\n");
            await fs.mkdir(path.join(dir, ".memory"));
            await fs.symlink(elsewhere, path.join(dir, ".memory", "staging"));
            await assert.rejects(processStagingOnce(dir, { log: quiet }), /not a real directory/);
            await assert.rejects(fs.access(path.join(dir, ".memory", "bot.lock")));
            assert.equal((await fs.lstat(path.join(dir, ".memory", "staging"))).isSymbolicLink(), true);
            await fs.access(path.join(elsewhere, "mem-aaaa0001.md"));
        });
    });
    it("does not recover an already-pushed branch for a proposal that fails validation", async () => {
        await withDir(async (root) => {
            const repo = await setupRepo(root);
            // The branch a real proposal with this file name would have pushed.
            sh(repo, "push", "origin", "main:refs/heads/memory/mem-aaaa0001");
            const file = stagedFile(repo, "mem-aaaa0001.md");
            await fs.mkdir(stagingDir(repo), { recursive: true });
            await fs.writeFile(file, "---\nid: mem-cccc0003\ntitle: X\nintent: propose\n---\nbody\n");
            let opened = 0;
            const res = await processStagingOnce(repo, {
                log: quiet,
                findPr: async () => {
                    throw new Error("must not look up a PR for a rejected proposal");
                },
                openPr: async () => {
                    opened++;
                    return "https://example.test/pr/1";
                },
            });
            assert.equal(res.recovered, 0);
            assert.equal(res.promoted, 0);
            assert.equal(res.failed, 1);
            assert.equal(opened, 0);
            await fs.access(file); // still staged
            assert.match(sh(repo, "ls-remote", "--heads", "origin", "memory/mem-aaaa0001"), /memory\/mem-aaaa0001/);
        });
    });
});
describe("publish failures stay visible after the call", () => {
    it("records the failing step, and the system prompt warns until it is cleared", async () => {
        await withDir(async (root) => {
            const repo = await setupRepo(root);
            await writeProposal(repo, { id: "mem-bbbbbbbb", title: "B", body: "body b", proposedAt: "2026-01-01", intent: "propose" });
            const failed = await processStagingOnce(repo, {
                log: quiet,
                findPr: async () => null,
                openPr: async () => {
                    throw new Error("gh down");
                },
            });
            assert.equal(failed.failed, 1);
            const state = await readPublishState(repo);
            assert.equal(state.lastOutcome, "failed");
            assert.ok(state.lastOutcomeAt);
            assert.match(state.lastError ?? "", /gh down/);
            // The proposal is still staged: the failure describes real pending work.
            await fs.access(path.join(stagingDir(repo), "mem-bbbbbbbb.md"));
            const warning = (await publishWarning(repo)) ?? "";
            assert.match(warning, /last memory publish FAILED/i);
            assert.match(warning, /gh down/);
            assert.match(warning, /memory_publish/);
            assert.match(warning, /retry/i);
            // A partial run may have opened some PRs; the claim must not overstate.
            assert.match(warning, /did not open a pull request for every proposal/);
        });
    });
    it("clears the warning once a later run publishes the proposal", async () => {
        await withDir(async (root) => {
            const repo = await setupRepo(root);
            await writeProposal(repo, { id: "mem-bbbbbbbb", title: "B", body: "body b", proposedAt: "2026-01-01", intent: "propose" });
            await processStagingOnce(repo, {
                log: quiet,
                findPr: async () => null,
                openPr: async () => {
                    throw new Error("gh down");
                },
            });
            assert.notEqual(await publishWarning(repo), null);
            // The earlier run pushed the branch; this one recovers it.
            const retried = await processStagingOnce(repo, {
                log: quiet,
                findPr: async () => "https://example.test/pr/9",
            });
            assert.equal(retried.failed, 0);
            assert.equal(retried.recovered, 1);
            assert.equal(await publishWarning(repo), null);
            const state = await readPublishState(repo);
            assert.equal(state.lastOutcome, "ok");
            assert.equal(state.lastError, undefined);
        });
    });
    it("clears the warning when a later run verifies nothing is staged", async () => {
        await withDir(async (root) => {
            const repo = await setupRepo(root);
            await recordPublishFailure(repo, "earlier failure");
            assert.match((await publishWarning(repo)) ?? "", /earlier failure/);
            const idle = await processStagingOnce(repo, { log: quiet });
            assert.equal(idle.promoted, 0);
            assert.equal(idle.failed, 0);
            assert.equal(await publishWarning(repo), null);
        });
    });
    it("does not clear a recorded failure while another run holds the lock", async () => {
        await withDir(async (root) => {
            const repo = await setupRepo(root);
            await writeProposal(repo, { id: "mem-hhhhhhhh", title: "H", body: "h", proposedAt: "2026-01-01", intent: "propose" });
            await recordPublishFailure(repo, "earlier failure");
            const release = await acquireLock(repo);
            assert.ok(release);
            try {
                const busy = await processStagingOnce(repo, { log: quiet, findPr: async () => null, openPr: async () => "x" });
                assert.equal(busy.busy, true);
            }
            finally {
                await release();
            }
            assert.equal((await readPublishState(repo)).lastOutcome, "failed");
            assert.match((await publishWarning(repo)) ?? "", /earlier failure/);
        });
    });
    it("records an exception thrown before any result, without replacing it", async () => {
        await withDir(async (dir) => {
            const elsewhere = path.join(dir, "elsewhere");
            await fs.mkdir(elsewhere);
            await fs.mkdir(path.join(dir, ".memory"));
            await fs.symlink(elsewhere, path.join(dir, ".memory", "staging"));
            await assert.rejects(processStagingOnce(dir, { log: quiet }), /not a real directory/);
            const state = await readPublishState(dir);
            assert.equal(state.lastOutcome, "failed");
            assert.match(state.lastError ?? "", /not a real directory/);
        });
    });
    it("keeps the per-proposal reason for a rejected staged file", async () => {
        await withDir(async (dir) => {
            const file = path.join(stagingDir(dir), "mem-aaaa0001.md");
            await fs.mkdir(stagingDir(dir), { recursive: true });
            await fs.writeFile(file, "---\nid: mem-bbbb0002\ntitle: X\nintent: propose\n---\nbody\n");
            const res = await processStagingOnce(dir, { log: quiet, openPr: async () => "https://example.test/pr/1" });
            assert.equal(res.failed, 1);
            assert.match((await readPublishState(dir)).lastError ?? "", /frontmatter id/);
        });
    });
});
describe("publish state is written only when it changes", () => {
    it("a quiet run with no recorded failure writes nothing", async () => {
        await withDir(async (root) => {
            const repo = await setupRepo(root);
            await fs.mkdir(path.join(stagingDir(repo)), { recursive: true });
            const res = await processStagingOnce(repo, { log: quiet });
            assert.equal(res.promoted + res.failed + res.skipped, 0);
            await assert.rejects(fs.access(path.join(repo, ".memory", "publish-state.json")));
        });
    });
});
describe("CLI argument handling", () => {
    it("refuses a --dir flag with no value instead of quietly using the current directory", async () => {
        await withDir(async (dir) => {
            await fs.mkdir(path.join(dir, ".memory", "staging"), { recursive: true });
            const run = spawnSync(process.execPath, [fileURLToPath(new URL("./bot.js", import.meta.url)), "once", "--dir"], {
                cwd: dir,
                encoding: "utf8",
            });
            assert.ifError(run.error);
            assert.notEqual(run.status, 0);
            assert.match(run.stderr, /--dir requires a path/);
            assert.doesNotMatch(run.stdout, /no staged proposals/);
        });
    });
});
describe("publish record cannot be redirected by a symlinked .memory", () => {
    it("a symlinked .memory refuses the run and receives no publish-state.json through its target", async () => {
        await withDir(async (dir) => {
            const elsewhere = path.join(dir, "elsewhere");
            await fs.mkdir(path.join(elsewhere, "staging"), { recursive: true });
            await fs.writeFile(path.join(elsewhere, "staging", "mem-aaaa0001.md"), "---\nid: mem-aaaa0001\ntitle: X\nintent: propose\n---\nbody\n", "utf8");
            await fs.symlink(elsewhere, path.join(dir, ".memory"));
            await assert.rejects(processStagingOnce(dir, { log: quiet }), /not a real directory/);
            // The failure is real, but recording it must not write through the link.
            assert.deepEqual(await fs.readdir(elsewhere), ["staging"]);
            await assert.rejects(fs.access(path.join(elsewhere, "publish-state.json")));
            await assert.rejects(fs.access(path.join(dir, ".memory", "publish-state.json")));
        });
    });
    it("still creates .memory when it is absent", async () => {
        await withDir(async (dir) => {
            await recordPublishFailure(dir, "earlier failure");
            const state = await readPublishState(dir);
            assert.equal(state.lastOutcome, "failed");
            assert.match(state.lastError ?? "", /earlier failure/);
        });
    });
});
//# sourceMappingURL=bot.test.js.map