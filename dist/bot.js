#!/usr/bin/env node
/**
 * The memory bot — the only component that holds repository credentials and
 * runs git. It watches the git-ignored `.memory/staging/` folder and turns
 * each staged proposal into a pull request:
 *
 *   propose → branch, commit the file into `memory/active/` (moving any
 *             `supersedes` targets to `memory/retired/`), open a PR, remove the
 *             staged file.
 *   retire  → move `memory/active/<id>` to `memory/retired/` with a reason,
 *             open a PR, remove the staged file.
 *
 * There is no index file to maintain: the prompt index is derived from
 * `memory/active/` at session start.
 *
 * Invocation (as a developer-machine daemon or CLI):
 *   node dist/bot.js once       process staged proposals, then exit
 *   node dist/bot.js watch      poll staging forever (default interval 2s)
 */
import fs from "fs/promises";
import os from "os";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { activeDir, listStagedProposals, readMemoryFile, retiredDir, stagingDir, writeMemoryFile, } from "./storage.js";
// ─── Child processes ─────────────────────────────────────────────────────────
function run(cmd, args, cwd) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(`${cmd} ${args.join(" ")}: ${(stderr || err.message).trim()}`));
                return;
            }
            resolve(stdout.trim());
        });
    });
}
function git(args, cwd) {
    return run("git", args, cwd);
}
function gh(args, cwd) {
    return run("gh", args, cwd);
}
/**
 * `owner/repo` (or `host/owner/repo` for non-github.com hosts) of a git remote
 * URL, in the form `gh --repo` accepts. Undefined for local paths and anything
 * that is not a hosted `owner/repo` URL.
 */
export function parseRemoteUrl(url) {
    const u = url.trim();
    const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(u) ??
        /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(u);
    if (!m)
        return undefined;
    const host = m[1];
    const repoPath = m[2];
    if (repoPath.split("/").filter(Boolean).length !== 2)
        return undefined;
    return host.toLowerCase() === "github.com" ? repoPath : `${host}/${repoPath}`;
}
/** The repo that `origin` points at, so PRs always target the repo we push to (not a fork's upstream). */
async function repoSlug(cwd) {
    try {
        return parseRemoteUrl(await git(["remote", "get-url", "origin"], cwd));
    }
    catch {
        return undefined;
    }
}
/** The repository's default branch (main/master), used as the PR base. */
export async function defaultBranch(cwd, repo) {
    try {
        const name = await gh(["repo", "view", ...(repo ? [repo] : []), "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], cwd);
        if (name)
            return name;
    }
    catch {
        // fall through to git fallback
    }
    try {
        const ref = await git(["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd);
        if (ref)
            return ref.replace(/^origin\//, "");
    }
    catch {
        // fall through
    }
    return "main";
}
// ─── Pure filesystem transforms (no git) ────────────────────────────────────
/**
 * Promote a `propose` proposal into `memory/active/`, retiring any superseded
 * memories. Does NOT remove the staged file (the orchestrator does that only
 * after the PR opens). Idempotent: re-running overwrites the active file and
 * skips supersede targets that are already gone.
 *
 * Returns the list of filesystem paths changed (for logging).
 */
export async function applyPropose(projectDir, memory) {
    const promoted = { ...memory };
    delete promoted.intent; // staging-only directive, never written to active/
    await writeMemoryFile(activeDir(projectDir), promoted);
    const changed = [path.join(activeDir(projectDir), `${memory.id}.md`)];
    for (const oldId of memory.supersedes ?? []) {
        const old = await readMemoryFile(path.join(activeDir(projectDir), `${oldId}.md`));
        if (!old)
            continue; // already retired (idempotent re-run)
        old.supersededBy = memory.id;
        old.retiredReason = "superseded";
        old.retiredAt = new Date().toISOString();
        await writeMemoryFile(retiredDir(projectDir), old);
        await fs.rm(path.join(activeDir(projectDir), `${oldId}.md`), { force: true });
        changed.push(path.join(retiredDir(projectDir), `${oldId}.md`));
    }
    return changed;
}
/**
 * Promote a `retire` proposal: move `memory/active/<id>` to `memory/retired/`
 * with the reason from the staged file. Does NOT remove the staged file.
 * Idempotent: a missing active file means it was already retired.
 */
export async function applyRetire(projectDir, staged) {
    const id = staged.id;
    const active = await readMemoryFile(path.join(activeDir(projectDir), `${id}.md`));
    if (!active)
        return []; // already retired
    active.retiredReason = staged.retiredReason ?? "stale";
    active.retiredAt = new Date().toISOString();
    if (staged.supersededBy)
        active.supersededBy = staged.supersededBy;
    await writeMemoryFile(retiredDir(projectDir), active);
    await fs.rm(path.join(activeDir(projectDir), `${id}.md`), { force: true });
    return [path.join(retiredDir(projectDir), `${id}.md`)];
}
// ─── PR title / body template ───────────────────────────────────────────────
const CHECKLIST = [
    "True — correct today",
    "Relevant — points at something that still exists",
    "Useful — a future session would waste time re-learning it if absent",
    "Scoped — one entry, one rule",
    "Clean — no secrets, no customer data, no credentials",
    "Not a duplicate — checked against active and proposed memories",
];
export function buildPrTitle(memory) {
    if (memory.intent === "retire")
        return `memory: retire ${memory.id}`;
    const title = memory.title.length > 72 ? `${memory.title.slice(0, 72)}…` : memory.title;
    return `memory: ${title}`;
}
export function buildPrBody(memory) {
    const lines = ["## Memory proposal", ""];
    lines.push(`- **ID**: \`${memory.id}\``);
    lines.push(`- **Title**: ${memory.title}`);
    if (memory.author)
        lines.push(`- **Author**: ${memory.author}`);
    if (memory.intent === "retire") {
        lines.push(`- **Intent**: retire (reason: ${memory.retiredReason ?? "stale"})`);
        if (memory.supersededBy)
            lines.push(`- **Superseded by**: \`${memory.supersededBy}\``);
    }
    else {
        lines.push(`- **Intent**: propose`);
        if (memory.supersedes?.length)
            lines.push(`- **Supersedes**: ${memory.supersedes.map((id) => `\`${id}\``).join(", ")}`);
        if (memory.tags?.length)
            lines.push(`- **Tags**: ${memory.tags.join(", ")}`);
    }
    lines.push("");
    lines.push("Merging this PR makes the memory active. Review against the memory checklist:");
    lines.push("");
    for (const item of CHECKLIST)
        lines.push(`- ${item}`);
    if (memory.source)
        lines.push("", `Source: ${memory.source}`);
    return lines.join("\n");
}
/** `gh pr create` arguments; `--repo` pins the PR to the repo we push to. */
export function buildPrCreateArgs(req) {
    return [
        "pr", "create",
        ...(req.repo ? ["--repo", req.repo] : []),
        "--base", req.base, "--head", req.branch, "--title", req.title, "--body", req.body,
    ];
}
/** `gh pr list` arguments that find a PR in any state for a head branch. */
export function buildPrListArgs(req) {
    return ["pr", "list", ...(req.repo ? ["--repo", req.repo] : []), "--head", req.branch, "--state", "all", "--limit", "1", "--json", "url", "--jq", ".[0].url // empty"];
}
async function defaultOpenPr(req) {
    return gh(buildPrCreateArgs(req), req.cwd);
}
async function defaultFindPr(req) {
    const url = await gh(buildPrListArgs(req), req.cwd);
    return url || null;
}
/**
 * Branch for a proposal. A retire proposal carries the id of the memory it
 * retires, which already has an add branch (`memory/<id>`) that is usually kept
 * after merge, so retires get their own namespace, made unique per proposal by
 * its proposal time (stable across retries of the same proposal).
 */
export function branchFor(memory) {
    if (memory.intent !== "retire")
        return `memory/${memory.id}`;
    const stamp = (memory.proposedAt ?? "").replace(/\D/g, "").slice(0, 14) || "0";
    return `memory/retire/${memory.id}-${stamp}`;
}
// ─── Single-run lock ─────────────────────────────────────────────────────────
/** A lock older than this is stale even if its pid is alive (pids are reused; OpenCode is long-lived). */
const LOCK_STALE_MS = 30 * 60_000;
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM";
    }
}
function lockPath(projectDir) {
    return path.join(path.dirname(stagingDir(projectDir)), "bot.lock");
}
/**
 * Take the single-run lock; returns a release function, or null when another
 * live, recent run holds it. The lock file appears atomically with its full
 * content (written to a temp file, then hard-linked into place), so a reader
 * never sees an empty or partial lock. A stale lock is removed only if it is
 * unchanged since it was judged stale; two processes racing to take over the
 * same stale lock can still both win in a very narrow window.
 */
export async function acquireLock(projectDir) {
    const lock = lockPath(projectDir);
    await fs.mkdir(path.dirname(lock), { recursive: true });
    const token = `${process.pid}:${Date.now()}:${crypto.randomBytes(4).toString("hex")}`;
    const tmp = `${lock}.${token.replace(/:/g, "-")}.tmp`;
    await fs.writeFile(tmp, token, "utf8");
    const release = async () => {
        const current = await fs.readFile(lock, "utf8").catch(() => "");
        if (current === token)
            await fs.rm(lock, { force: true });
    };
    try {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await fs.link(tmp, lock);
                return release;
            }
            catch (err) {
                const code = err.code;
                if (code === "EEXIST") {
                    // fall through to the staleness check below
                }
                else if (code === "EPERM" || code === "ENOSYS" || code === "ENOTSUP" || code === "EXDEV") {
                    // filesystem without hard links: exclusive create is the best available
                    try {
                        await fs.writeFile(lock, token, { encoding: "utf8", flag: "wx" });
                        return release;
                    }
                    catch (err2) {
                        if (err2.code !== "EEXIST")
                            throw err2;
                    }
                }
                else {
                    throw err;
                }
            }
            const seen = await fs.readFile(lock, "utf8").catch(() => null);
            if (seen === null)
                continue; // released between our attempt and the read
            const [pidText, tsText] = seen.split(":");
            const pid = Number(pidText);
            const ts = Number(tsText);
            const fresh = Number.isFinite(ts) && Date.now() - ts < LOCK_STALE_MS;
            if (pid > 0 && pidAlive(pid) && fresh)
                return null;
            if ((await fs.readFile(lock, "utf8").catch(() => null)) === seen)
                await fs.rm(lock, { force: true });
        }
        return null;
    }
    finally {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
}
// ─── Worktree housekeeping ───────────────────────────────────────────────────
/**
 * Remove worktrees left behind by an earlier crashed run (named memory-bot-*),
 * then prune records of worktrees whose directory is gone. Safe because the
 * caller holds the single-run lock, so no live run owns one.
 */
async function cleanStaleWorktrees(cwd, log) {
    let listing = "";
    try {
        listing = await git(["worktree", "list", "--porcelain"], cwd);
    }
    catch {
        return;
    }
    for (const line of listing.split("\n")) {
        if (!line.startsWith("worktree "))
            continue;
        const dir = line.slice("worktree ".length).trim();
        if (!path.basename(dir).startsWith("memory-bot-"))
            continue;
        await git(["worktree", "remove", "--force", dir], cwd).catch(() => undefined);
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        log(`removed stale worktree ${dir}`);
    }
    await git(["worktree", "prune"], cwd).catch(() => undefined);
}
async function remoteBranchExists(cwd, branch) {
    const out = await git(["ls-remote", "--heads", "origin", branch], cwd);
    return out.length > 0;
}
/**
 * Process every staged proposal once. All git work happens in a throwaway git
 * worktree, so the developer's checkout (branch, index, uncommitted files) is
 * never touched. For each proposal:
 *   1. if its branch is already on the remote (an earlier run pushed it but did
 *      not finish), find its PR, or open one, and drop the staged file;
 *   2. otherwise branch off the fetched default branch in the worktree, apply
 *      the transform, commit, push, open PR, drop the staged file;
 *   3. on failure leave the staged file for the next run.
 */
export async function processStagingOnce(projectDir, opts = {}) {
    const cwd = opts.cwd ?? projectDir;
    const log = opts.log ?? ((line) => console.error(line));
    const openPr = opts.openPr ?? defaultOpenPr;
    const findPr = opts.findPr ?? defaultFindPr;
    const result = { promoted: 0, skipped: 0, failed: 0, recovered: 0, prs: [] };
    const staged = await listStagedProposals(projectDir);
    if (staged.length === 0)
        return result;
    const release = await acquireLock(projectDir);
    if (!release) {
        log("another bot run is in progress; skipping");
        return { ...result, busy: true };
    }
    let worktree;
    try {
        await cleanStaleWorktrees(cwd, log);
        const repo = await repoSlug(cwd);
        const base = await defaultBranch(cwd, repo);
        try {
            await git(["fetch", "origin"], cwd);
        }
        catch {
            // best-effort; fall back to the local ref below
        }
        let startRef = `origin/${base}`;
        try {
            await git(["rev-parse", "--verify", "--quiet", startRef], cwd);
        }
        catch {
            startRef = base;
        }
        worktree = await fs.mkdtemp(path.join(os.tmpdir(), "memory-bot-"));
        await git(["worktree", "add", "--detach", worktree, startRef], cwd);
        // Process deterministically (by id) so behaviour is stable across runs.
        for (const memory of [...staged].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
            const branch = branchFor(memory);
            const title = buildPrTitle(memory);
            const body = buildPrBody(memory);
            try {
                if (await remoteBranchExists(cwd, branch)) {
                    const url = (await findPr({ cwd: worktree, ...(repo ? { repo } : {}), branch })) ?? (await openPr({ cwd: worktree, ...(repo ? { repo } : {}), base, branch, title, body }));
                    await fs.rm(path.join(stagingDir(projectDir), `${memory.id}.md`), { force: true });
                    log(`recovered ${memory.id}: branch ${branch} was already pushed${url ? ` ${url}` : ""}`);
                    result.recovered++;
                    if (url)
                        result.prs.push(url);
                    continue;
                }
                // A local branch that never reached the remote must not block a fresh attempt.
                await git(["branch", "-D", branch], cwd).catch(() => undefined);
                await git(["checkout", "-b", branch, startRef], worktree);
                const changed = memory.intent === "retire" ? await applyRetire(worktree, memory) : await applyPropose(worktree, memory);
                if (changed.length === 0) {
                    log(`skip ${memory.id}: nothing to change`);
                    result.skipped++;
                    continue;
                }
                await git(["add", "--all", "memory"], worktree);
                await git(["commit", "-m", commitMessage(memory)], worktree);
                await git(["push", "-u", "origin", branch], worktree);
                const url = await openPr({ cwd: worktree, ...(repo ? { repo } : {}), base, branch, title, body });
                await fs.rm(path.join(stagingDir(projectDir), `${memory.id}.md`), { force: true });
                log(`promoted ${memory.id} (${memory.intent === "retire" ? "retire" : "propose"})${url ? ` ${url}` : ""}`);
                result.promoted++;
                if (url)
                    result.prs.push(url);
            }
            catch (err) {
                log(`failed ${memory.id}: ${err instanceof Error ? err.message : String(err)}`);
                result.failed++;
            }
            finally {
                await git(["checkout", "--detach", startRef], worktree).catch(() => undefined);
                // The local branch is not needed once pushed; a pushed branch is found again on the remote next run.
                await git(["branch", "-D", branch], cwd).catch(() => undefined);
            }
        }
    }
    finally {
        if (worktree) {
            await git(["worktree", "remove", "--force", worktree], cwd).catch(() => undefined);
            await fs.rm(worktree, { recursive: true, force: true }).catch(() => undefined);
        }
        await git(["worktree", "prune"], cwd).catch(() => undefined);
        await release();
    }
    return result;
}
function commitMessage(memory) {
    if (memory.intent === "retire")
        return `memory: retire ${memory.id}`;
    const title = memory.title.length > 60 ? `${memory.title.slice(0, 60)}…` : memory.title;
    return `memory: add ${memory.id} — ${title}`;
}
// ─── Watch / regenerate / CLI ───────────────────────────────────────────────
/** Poll staging forever, processing new proposals as they appear. */
export async function startWatch(projectDir, intervalMs, opts = {}) {
    const log = opts.log ?? ((line) => console.error(line));
    // Process immediately, then on an interval.
    for (;;) {
        try {
            const result = await processStagingOnce(projectDir, opts);
            if (result.promoted > 0)
                log(`promoted ${result.promoted} proposal${result.promoted === 1 ? "" : "s"}`);
        }
        catch (err) {
            log(`bot error: ${err instanceof Error ? err.message : String(err)}`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}
function printUsage() {
    console.error([
        "opencode-memory-bot — turn staged memory proposals into pull requests",
        "",
        "Usage:",
        "  node dist/bot.js once [--dir <path>]        process staged proposals, then exit",
        "  node dist/bot.js watch [--dir <path>] [--interval <ms>]   poll staging forever",
    ].join("\n"));
}
async function main() {
    const argv = process.argv.slice(2);
    const command = argv[0] ?? "once";
    const dirArg = argv.includes("--dir") ? argv[argv.indexOf("--dir") + 1] : undefined;
    const projectDir = path.resolve(dirArg ?? process.cwd());
    const intervalArg = argv.includes("--interval") ? argv[argv.indexOf("--interval") + 1] : undefined;
    const intervalMs = intervalArg ? Number(intervalArg) || 2000 : 2000;
    switch (command) {
        case "once": {
            const result = await processStagingOnce(projectDir);
            if (result.recovered > 0)
                console.log(`recovered ${result.recovered} proposal${result.recovered === 1 ? "" : "s"} (branch already pushed)`);
            if (result.promoted > 0)
                console.log(`promoted ${result.promoted} proposal${result.promoted === 1 ? "" : "s"}`);
            else if (result.skipped > 0)
                console.log(`skipped ${result.skipped} proposal${result.skipped === 1 ? "" : "s"}`);
            else
                console.log("no staged proposals");
            if (result.failed > 0) {
                console.error(`${result.failed} proposal${result.failed === 1 ? "" : "s"} failed; left in staging`);
                process.exitCode = 1;
            }
            return;
        }
        case "watch": {
            console.error(`watching ${path.join(projectDir, ".memory", "staging")} every ${intervalMs}ms`);
            await startWatch(projectDir, intervalMs);
            return;
        }
        case "regenerate": {
            // Kept as a no-op so older CI jobs that still call it fail nothing.
            console.log("memory/_summary.md is no longer used; the index is derived from memory/active/ at session start");
            return;
        }
        case "help":
        case "--help":
        case "-h":
            printUsage();
            return;
        default:
            printUsage();
            process.exitCode = 2;
    }
}
// Run the CLI only when executed directly (not when imported by tests).
const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    main().catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
    });
}
//# sourceMappingURL=bot.js.map