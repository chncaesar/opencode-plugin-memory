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
import { realpathSync } from "fs";
import os from "os";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { activeDir, isMemoryId, machineDir, memoryRootDir, readMemoryFileNoFollow, retiredDir, stagingDir, writeMemoryFile, } from "./storage.js";
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
// ─── Filesystem boundary ────────────────────────────────────────────────────
//
// The bot turns files it did not create into git commits and deletes files
// after pushing. Both directions must stay inside the memory store: a symlink
// at `.memory/`, a directory at a leaf path, or a file whose frontmatter id
// disagrees with its name would silently redirect a read, a write or a delete.
//
// Every path is classified with `lstat` (never following a link) before use,
// reads use O_NOFOLLOW where available and writes replace the leaf by rename. A path of the
// wrong kind is refused rather than repaired. This is a boundary check, not a
// transaction: a concurrent process can still swap a validated path before the
// operation (TOCTOU). Defeating that would need directory handles and
// openat-style calls; the residual window is accepted and every operation
// re-checks its leaf where it can.
/** Thrown when a path the bot is about to touch is not the expected kind of entry. */
export class MemoryBoundaryError extends Error {
    constructor(message) {
        super(message);
        this.name = "MemoryBoundaryError";
    }
}
function errorCode(err) {
    return err instanceof Error && "code" in err ? err.code : undefined;
}
/** Classify a path without following a symlink. */
async function entryKind(filePath) {
    let stat;
    try {
        stat = await fs.lstat(filePath);
    }
    catch (err) {
        if (errorCode(err) === "ENOENT")
            return "missing";
        throw err;
    }
    if (stat.isSymbolicLink())
        return "symlink";
    if (stat.isDirectory())
        return "dir";
    if (stat.isFile())
        return stat.nlink === 1 ? "file" : "hardlink";
    return "other";
}
function describeKind(kind) {
    switch (kind) {
        case "symlink":
            return "a symlink";
        case "hardlink":
            return "a multiply linked file";
        case "dir":
            return "a directory";
        case "file":
            return "a regular file";
        case "other":
            return "a special file";
        case "missing":
            return "missing";
    }
}
/** Allow a real directory or a missing one (to be created); refuse everything else. */
async function assertRealDir(dirPath, label) {
    const kind = await entryKind(dirPath);
    if (kind === "dir" || kind === "missing")
        return kind;
    throw new MemoryBoundaryError(`${label} is ${describeKind(kind)}, not a real directory; refusing to touch it`);
}
/** Allow a regular file or a missing one; refuse symlinks and directories. */
async function assertRegularFileOrMissing(filePath, label) {
    const kind = await entryKind(filePath);
    if (kind === "file" || kind === "missing")
        return kind;
    throw new MemoryBoundaryError(`${label} is ${describeKind(kind)}, not a regular file; refusing to touch it`);
}
async function ensureRealDir(dirPath, label) {
    if ((await assertRealDir(dirPath, label)) === "dir")
        return;
    await fs.mkdir(dirPath, { recursive: true });
    // mkdir does not follow a symlink that appears at the final component, but a
    // racing process could still have put one there.
    if ((await entryKind(dirPath)) !== "dir") {
        throw new MemoryBoundaryError(`${label} was not created as a real directory; refusing to write`);
    }
}
/**
 * Write `memory` into `dirPath` without following a symlink at the leaf. An
 * existing file must be readable and carry the same id, so a re-run overwrites
 * only the file it meant to write.
 */
async function writeMemoryFileAt(dirPath, memory, label) {
    const file = path.join(dirPath, `${memory.id}.md`);
    if ((await assertRegularFileOrMissing(file, label)) === "file") {
        const existing = await readMemoryFileNoFollow(file);
        if (!existing || existing.id !== memory.id) {
            throw new MemoryBoundaryError(`${label} does not contain ${memory.id}; refusing to overwrite it`);
        }
    }
    await writeMemoryFile(dirPath, memory);
    return file;
}
/**
 * Read and validate every active memory a proposal supersedes, before anything
 * is written. Missing targets are skipped (already retired, an idempotent
 * re-run); present ones must be regular, readable and named after their id.
 */
async function inspectSupersedeTargets(projectDir, ids) {
    const targets = [];
    for (const id of ids) {
        if (!isMemoryId(id)) {
            throw new MemoryBoundaryError(`supersedes reference ${JSON.stringify(id)} is not a memory id`);
        }
        const file = path.join(activeDir(projectDir), `${id}.md`);
        if ((await assertRegularFileOrMissing(file, `active memory ${id}`)) === "missing")
            continue;
        const memory = await readMemoryFileNoFollow(file);
        if (!memory)
            throw new MemoryBoundaryError(`active memory ${id} is not a readable memory file; refusing to retire it`);
        if (memory.id !== id) {
            throw new MemoryBoundaryError(`active file ${id}.md contains ${memory.id}; refusing to retire it`);
        }
        targets.push({ id, file, memory });
    }
    return targets;
}
// ─── Pure filesystem transforms (no git) ────────────────────────────────────
/**
 * Promote a `propose` proposal into `memory/active/`, retiring any superseded
 * memories. Does NOT remove the staged file (the orchestrator does that only
 * after the PR opens). Idempotent: re-running overwrites the active file and
 * skips supersede targets that are already gone.
 *
 * Every path it will read, write or delete is validated first, so a bad
 * directory or leaf aborts the transform before the first write. Returns the
 * list of filesystem paths changed (for logging).
 */
export async function applyPropose(projectDir, memory) {
    if (!isMemoryId(memory.id)) {
        throw new MemoryBoundaryError(`proposal id ${JSON.stringify(memory.id)} is not a memory id`);
    }
    const supersedes = memory.supersedes ?? [];
    for (const id of supersedes) {
        if (!isMemoryId(id)) {
            throw new MemoryBoundaryError(`supersedes reference ${JSON.stringify(id)} is not a memory id`);
        }
    }
    const active = activeDir(projectDir);
    const retired = retiredDir(projectDir);
    // Preflight — nothing is created or written until every touched path is known.
    await assertRealDir(memoryRootDir(projectDir), "memory root");
    await assertRealDir(active, "memory/active");
    if (supersedes.length > 0)
        await assertRealDir(retired, "memory/retired");
    const target = path.join(active, `${memory.id}.md`);
    if ((await assertRegularFileOrMissing(target, `active memory ${memory.id}`)) === "file") {
        const existing = await readMemoryFileNoFollow(target);
        if (!existing || existing.id !== memory.id) {
            throw new MemoryBoundaryError(`active file ${memory.id}.md does not contain ${memory.id}; refusing to overwrite it`);
        }
    }
    const retiring = await inspectSupersedeTargets(projectDir, supersedes);
    for (const item of retiring) {
        const retiredFile = path.join(retired, `${item.id}.md`);
        if ((await assertRegularFileOrMissing(retiredFile, `retired memory ${item.id}`)) === "file") {
            const existing = await readMemoryFileNoFollow(retiredFile);
            if (!existing || existing.id !== item.id) {
                throw new MemoryBoundaryError(`retired file ${item.id}.md does not contain ${item.id}; refusing to overwrite it`);
            }
        }
    }
    // Boundary is sound: create directories, then write.
    await ensureRealDir(memoryRootDir(projectDir), "memory root");
    await ensureRealDir(active, "memory/active");
    const promoted = { ...memory };
    delete promoted.intent; // staging-only directive, never written to active/
    const changed = [await writeMemoryFileAt(active, promoted, `active memory ${memory.id}`)];
    for (const item of retiring) {
        const old = { ...item.memory };
        old.supersededBy = memory.id;
        old.retiredReason = "superseded";
        old.retiredAt = new Date().toISOString();
        await ensureRealDir(retired, "memory/retired");
        await writeMemoryFileAt(retired, old, `retired memory ${item.id}`);
        // Re-check the leaf immediately before unlinking it.
        const kind = await entryKind(item.file);
        if (kind !== "missing" && kind !== "file") {
            throw new MemoryBoundaryError(`active memory ${item.id} changed to ${describeKind(kind)}; refusing to delete it`);
        }
        await fs.rm(item.file, { force: true });
        changed.push(path.join(retired, `${item.id}.md`));
    }
    return changed;
}
/**
 * Promote a `retire` proposal: move `memory/active/<id>` to `memory/retired/`
 * with the reason from the staged file. Does NOT remove the staged file.
 * Idempotent: a missing active file means it was already retired.
 *
 * Every touched path is validated before the first write, so a symlinked or
 * malformed entry is left for a human instead of being followed.
 */
export async function applyRetire(projectDir, staged) {
    const id = staged.id;
    if (!isMemoryId(id)) {
        throw new MemoryBoundaryError(`retire target ${JSON.stringify(id)} is not a memory id`);
    }
    if (staged.supersededBy !== undefined && !isMemoryId(staged.supersededBy)) {
        throw new MemoryBoundaryError(`superseded_by ${JSON.stringify(staged.supersededBy)} is not a memory id`);
    }
    const active = activeDir(projectDir);
    const retired = retiredDir(projectDir);
    await assertRealDir(memoryRootDir(projectDir), "memory root");
    await assertRealDir(active, "memory/active");
    const activeFile = path.join(active, `${id}.md`);
    if ((await assertRegularFileOrMissing(activeFile, `active memory ${id}`)) === "missing") {
        return []; // already retired
    }
    const memory = await readMemoryFileNoFollow(activeFile);
    if (!memory)
        throw new MemoryBoundaryError(`active memory ${id} is not a readable memory file; refusing to retire it`);
    if (memory.id !== id) {
        throw new MemoryBoundaryError(`active file ${id}.md contains ${memory.id}; refusing to retire it`);
    }
    await assertRealDir(retired, "memory/retired");
    const retiredFile = path.join(retired, `${id}.md`);
    if ((await assertRegularFileOrMissing(retiredFile, `retired memory ${id}`)) === "file") {
        const existing = await readMemoryFileNoFollow(retiredFile);
        if (!existing || existing.id !== id) {
            throw new MemoryBoundaryError(`retired file ${id}.md does not contain ${id}; refusing to overwrite it`);
        }
    }
    memory.retiredReason = staged.retiredReason ?? "stale";
    memory.retiredAt = new Date().toISOString();
    if (staged.supersededBy)
        memory.supersededBy = staged.supersededBy;
    await ensureRealDir(retired, "memory/retired");
    await writeMemoryFileAt(retired, memory, `retired memory ${id}`);
    const kind = await entryKind(activeFile);
    if (kind !== "missing" && kind !== "file") {
        throw new MemoryBoundaryError(`active memory ${id} changed to ${describeKind(kind)}; refusing to delete it`);
    }
    await fs.rm(activeFile, { force: true });
    return [retiredFile];
}
/** Ids a proposal points at must be well-formed, or the bot would touch a path it cannot name safely. */
function invalidStagedReference(memory) {
    for (const ref of memory.supersedes ?? []) {
        if (!isMemoryId(ref))
            return `supersedes reference ${JSON.stringify(ref)} is not a memory id`;
    }
    if (memory.supersededBy !== undefined && !isMemoryId(memory.supersededBy)) {
        return `superseded_by ${JSON.stringify(memory.supersededBy)} is not a memory id`;
    }
    if (memory.intent !== undefined && memory.intent !== "propose" && memory.intent !== "retire") {
        return `intent ${JSON.stringify(memory.intent)} is not propose or retire`;
    }
    return undefined;
}
/**
 * Validate the staging boundary before anything else runs. The lock lives in
 * `.memory`, so a symlinked or non-directory `.memory` / `.memory/staging` (or a
 * symlinked lock file) would redirect the lock and every staged read; those
 * cases abort the whole run. Individual files are judged one by one: an invalid
 * entry is reported and left untouched while valid proposals still proceed.
 */
async function scanStaging(projectDir) {
    const staging = stagingDir(projectDir);
    if ((await assertRealDir(machineDir(projectDir), ".memory")) === "missing") {
        return { items: [], rejected: [], disappeared: [] };
    }
    if ((await assertRealDir(staging, ".memory/staging")) === "missing") {
        return { items: [], rejected: [], disappeared: [] };
    }
    await assertRegularFileOrMissing(lockPath(projectDir), ".memory/bot.lock");
    const names = (await fs.readdir(staging)).filter((name) => name.endsWith(".md")).sort();
    const items = [];
    const rejected = [];
    const disappeared = [];
    for (const name of names) {
        const id = name.slice(0, -".md".length);
        if (!isMemoryId(id)) {
            // Only names that claim to be proposals are judged; other .md files are not ours.
            if (name.startsWith("mem-"))
                rejected.push({ name, reason: `${JSON.stringify(id)} is not a memory id` });
            continue;
        }
        const file = path.join(staging, name);
        const kind = await entryKind(file);
        if (kind === "missing") {
            disappeared.push(name);
            continue;
        }
        if (kind !== "file") {
            rejected.push({ name, reason: `expected a regular file, found ${describeKind(kind)}` });
            continue;
        }
        const memory = await readMemoryFileNoFollow(file);
        if (!memory) {
            rejected.push({ name, reason: "not a readable memory file" });
            continue;
        }
        if (memory.id !== id) {
            rejected.push({ name, reason: `frontmatter id ${memory.id} does not match file name ${id}` });
            continue;
        }
        const badReference = invalidStagedReference(memory);
        if (badReference) {
            rejected.push({ name, reason: badReference });
            continue;
        }
        items.push({ name, memory });
    }
    return { items, rejected, disappeared };
}
/**
 * Delete a staged file only if it is still a regular file. A symlink or a
 * directory is left in place for a human; the proposal it replaced stays
 * rejected rather than being followed or removed.
 */
async function removeStagedFile(projectDir, name, log) {
    if ((await assertRealDir(machineDir(projectDir), ".memory")) === "missing")
        return;
    if ((await assertRealDir(stagingDir(projectDir), ".memory/staging")) === "missing")
        return;
    const file = path.join(stagingDir(projectDir), name);
    const kind = await entryKind(file);
    if (kind === "missing")
        return;
    if (kind !== "file") {
        log(`left ${name} in staging: expected a regular file, found ${describeKind(kind)}`);
        return;
    }
    await fs.rm(file, { force: true });
}
// ─── PR title / body template ───────────────────────────────────────────────
const CHECKLIST = [
    "True — correct today",
    "Relevant — points at something that still exists",
    "Useful — a future session would waste time re-learning it if absent",
    "Scoped — one entry, one rule",
    "Clean — no secrets, no customer data, no credentials",
    "Not a duplicate — checked against active and proposed memories",
    "Not already stated — the code, tests and design doc do not already enforce this rule; if they do, close this PR instead of merging",
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
        const reason = memory.retiredReason ?? "stale";
        lines.push(`- **Intent**: retire (reason: ${reason})`);
        if (reason === "implemented") {
            lines.push("- **Graduated**: the artifact (code, tests or design doc) now states this rule; merging retires the memory because a second copy would drift");
        }
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
    lines.push(memory.intent === "retire"
        ? "Merging this PR retires the memory. Review against the memory checklist:"
        : "Merging this PR makes the memory active. Review against the memory checklist:");
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
// ─── Worktree lifecycle ──────────────────────────────────────────────────────
/**
 * Remove the one worktree this invocation created, using Git. Nothing here
 * scans for or deletes other worktrees: a directory whose name happens to start
 * with the bot's temp prefix may be the developer's checkout or an unrelated
 * worktree holding uncommitted work, and a name is not proof of ownership.
 *
 * The removal is Git's decision, so a refusal (locked worktree, permissions,
 * submodules) is honoured: the directory is logged and preserved for a human.
 * A leftover temp directory costs disk space; guessing ownership costs the
 * user their work.
 */
async function removeOwnWorktree(cwd, worktree, log) {
    try {
        await git(["worktree", "remove", "--force", worktree], cwd);
    }
    catch (err) {
        log(`could not remove worktree ${worktree}; leaving it in place for manual cleanup: ${err instanceof Error ? err.message : String(err)}`);
    }
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
 *   2. otherwise start from the fetched default branch in the worktree (detached,
 *      no local branch), apply the transform, commit, push an explicit ref, open
 *      PR, drop the staged file;
 *   3. on failure leave the staged file for the next run.
 */
export async function processStagingOnce(projectDir, opts = {}) {
    const cwd = opts.cwd ?? projectDir;
    const log = opts.log ?? ((line) => console.error(line));
    const openPr = opts.openPr ?? defaultOpenPr;
    const findPr = opts.findPr ?? defaultFindPr;
    const result = { promoted: 0, skipped: 0, failed: 0, recovered: 0, prs: [] };
    // Validate the staging boundary (including `.memory` itself, where the lock
    // will be created) before taking the shared lock. An invalid staging root is
    // a hard refusal: nothing is read, locked or changed.
    const scan = await scanStaging(projectDir);
    for (const name of scan.disappeared) {
        log(`skip ${name}: disappeared while scanning`);
        result.skipped++;
    }
    for (const bad of scan.rejected) {
        log(`rejected ${bad.name}: ${bad.reason}`);
        result.failed++;
    }
    if (scan.items.length === 0)
        return result;
    const release = await acquireLock(projectDir);
    if (!release) {
        log("another bot run is in progress; skipping");
        return { ...result, busy: true };
    }
    let worktree;
    try {
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
        const created = await fs.mkdtemp(path.join(os.tmpdir(), "memory-bot-"));
        try {
            await git(["worktree", "add", "--detach", created, startRef], cwd);
        }
        catch (err) {
            // Only remove the placeholder if it is still empty after the failed add.
            await fs.rmdir(created).catch(() => undefined);
            throw err;
        }
        worktree = created;
        // Process deterministically (by id) so behaviour is stable across runs.
        for (const item of [...scan.items].sort((a, b) => (a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0))) {
            const { name, memory } = item;
            const branch = branchFor(memory);
            const title = buildPrTitle(memory);
            const body = buildPrBody(memory);
            try {
                if (await remoteBranchExists(cwd, branch)) {
                    const url = (await findPr({ cwd: worktree, ...(repo ? { repo } : {}), branch })) ?? (await openPr({ cwd: worktree, ...(repo ? { repo } : {}), base, branch, title, body }));
                    await removeStagedFile(projectDir, name, log);
                    log(`recovered ${memory.id}: branch ${branch} was already pushed${url ? ` ${url}` : ""}`);
                    result.recovered++;
                    if (url)
                        result.prs.push(url);
                    continue;
                }
                // Commit on a detached HEAD and push an explicit ref. A prior crashed run
                // may still hold a `memory/<id>` branch checked out in its leftover
                // worktree; that leftover is preserved (not deleted), so depending on the
                // local branch would block every later attempt.
                const changed = memory.intent === "retire" ? await applyRetire(worktree, memory) : await applyPropose(worktree, memory);
                if (changed.length === 0) {
                    log(`skip ${memory.id}: nothing to change`);
                    result.skipped++;
                    continue;
                }
                await git(["add", "--all", "memory"], worktree);
                await git(["commit", "-m", commitMessage(memory)], worktree);
                await git(["push", "origin", `HEAD:refs/heads/${branch}`], worktree);
                const url = await openPr({ cwd: worktree, ...(repo ? { repo } : {}), base, branch, title, body });
                await removeStagedFile(projectDir, name, log);
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
                // Restore this run's own throwaway worktree to the fetched default branch
                // so the next proposal starts clean. Any commit already pushed lives on
                // the remote, and a half-applied failed attempt must not leak into the
                // next proposal's PR.
                await git(["reset", "--hard", startRef], worktree);
                await git(["clean", "-fd", "--", "memory"], worktree);
            }
        }
    }
    finally {
        try {
            if (worktree)
                await removeOwnWorktree(cwd, worktree, log);
        }
        finally {
            await release();
        }
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
            else if (result.failed === 0 && result.recovered === 0)
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
// npm bin links can leave argv[1] pointing at the link, not this module.
function isMain() {
    if (process.argv[1] === undefined)
        return false;
    try {
        return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    }
    catch {
        return false;
    }
}
if (isMain()) {
    main().catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
    });
}
//# sourceMappingURL=bot.js.map