import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
/**
 * The plugin-managed project store.
 *
 * A project's memory is committed in its own repository, but the plugin must
 * never run checkout/reset/clean against the developer's working tree: that tree
 * holds uncommitted work and its branch is the developer's business. It also
 * must not use the working tree as the runtime store root, because a proposal or
 * an audit write would then appear in the developer's `git status`.
 *
 * So each Git project gets one persistent, plugin-owned Git worktree outside the
 * developer checkout:
 *
 *   ~/.local/share/opencode/project-memory/<name>-<hash>/
 *     owner.json          ownership proof (repository + worktree + flags)
 *     worktree/           detached sparse checkout of `memory/` only
 *       memory/active/    merged truth, from the remote default branch
 *       memory/retired/
 *       .memory/          staging, audit state, plugin log, bot lock
 *
 * Identity is the canonical Git common directory, not the developer toplevel, so
 * two linked developer worktrees of one repository converge on one managed
 * store. The developer toplevel is used only as legacy-migration input.
 *
 * The worktree follows only the remote default branch and is updated with
 * `git fetch` + hard reset. That hard reset is permitted only after ownership is
 * proven: the manifest matches this repository and path, and the path is a
 * linked worktree of that repository. Anything else is refused, never repaired.
 *
 * The developer checkout is identity/input: `rev-parse`, `remote get-url`,
 * `symbolic-ref`, `ls-remote` and `fetch` may run against it; no command that
 * touches its working tree, index or HEAD ever does.
 *
 * Runtime state (`.memory/staging`, `.memory/audit-state.json`, the bot lock)
 * lives only in the managed worktree. When the managed store is first created,
 * a one-time migration copies an existing machine-local `.memory` state from the
 * developer checkout into it, excluding lock files. A hard reset does not remove
 * untracked files, so staged proposals and audit state survive refreshes.
 *
 * Only refresh *timing* is cached (see `DEFAULT_REFRESH_INTERVAL_MS`): the root
 * is a single filesystem path, never mirrored, overlaid or copied. Refreshes are
 * serialized by a lock under `<base>/.locks/`, outside every worktree so no
 * reset or cleanup can remove it.
 */
/** Segments under the user's home for the managed project stores. */
export const MANAGED_BASE_SEGMENTS = [".local", "share", "opencode", "project-memory"];
/** Ownership manifest inside the owner directory (outside the worktree). */
export const MANIFEST_FILE = "owner.json";
/** Directory inside the owner directory that holds the actual worktree. */
export const WORKTREE_DIR = "worktree";
/** Ownership marker carried inside the worktree itself (untracked by Git). */
export const WORKTREE_MARKER = ".memory-owner.json";
/** Owner directory sibling holding runtime state temporarily during recovery. */
const PENDING_STATE_DIR = "pending-state";
/** Incomplete-refresh transaction marker, outside the worktree. */
export const REFRESH_MARKER_FILE = "refresh.json";
/** Minimum time between two refreshes of the same managed store. */
export const DEFAULT_REFRESH_INTERVAL_MS = 30_000;
const LOCK_DIR = ".locks";
/** File inside a lease directory carrying the owner token. */
const LEASE_OWNER_FILE = "owner";
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 50;
const GIT_TIMEOUT_MS = 60_000;
const MEMORY_SPARSE_PATTERN = "memory/";
export const defaultGitRun = (args, cwd) => new Promise((resolve, reject) => {
    execFile("git", args, {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (err, stdout, stderr) => {
        if (err) {
            const detail = (stderr || err.message).trim().split(/\r?\n/).slice(-3).join(" ");
            reject(new Error(`git ${args.join(" ")}: ${detail}`));
            return;
        }
        resolve(stdout.trim());
    });
});
/** Thrown when a consumer cannot take the lease, or must not read a recovering store. */
export class StoreAccessError extends Error {
    constructor(message) {
        super(message);
        this.name = "StoreAccessError";
    }
}
/** Absolute base directory of all managed project stores. */
export function projectStoreBase(home = os.homedir()) {
    return path.join(home, ...MANAGED_BASE_SEGMENTS);
}
/**
 * Deterministic directory name for a repository: sanitized basename plus a hash
 * of the canonical path, so two checkouts with the same name never collide and
 * a moved checkout gets its own store.
 */
export function managedName(repository) {
    const canonical = path.resolve(repository);
    const hash = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 12);
    const base = path
        .basename(canonical)
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
    return `${base || "repository"}-${hash}`;
}
/** All paths of one managed store. */
export function managedPaths(repository, base) {
    const name = managedName(repository);
    const ownerDir = path.join(base, name);
    return {
        base,
        name,
        ownerDir,
        manifestFile: path.join(ownerDir, MANIFEST_FILE),
        worktree: path.join(ownerDir, WORKTREE_DIR),
    };
}
const cache = new Map();
const inflight = new Map();
const globalCache = new Map();
const globalInflight = new Map();
/**
 * Resolve the project store for `projectDir`.
 *
 * - A plain directory keeps the historical behaviour: the session directory is
 *   the store root.
 * - A Git project resolves its toplevel (even from a subdirectory) and uses the
 *   plugin-managed worktree. A copy of the developer checkout is never used.
 * - A refresh failure after a successful initialization returns the existing
 *   managed root; the first initialization failure returns an `unavailable`
 *   result rooted at the managed path, never at the developer checkout.
 */
export async function resolveProjectStore(projectDir, opts = {}) {
    const git = opts.git ?? defaultGitRun;
    const home = opts.home ?? os.homedir();
    const base = opts.base ? path.resolve(opts.base) : projectStoreBase(home);
    let toplevel = "";
    try {
        toplevel = (await git(["rev-parse", "--show-toplevel"], projectDir)).trim();
    }
    catch (err) {
        // Git is unavailable or this is not a working tree. If a `.git` entry marks
        // the directory as part of a repository, fail closed instead of treating the
        // developer checkout as a store; a plain directory keeps current behaviour.
        const fallbackRoot = await findGitRoot(projectDir);
        if (!fallbackRoot)
            return { status: "project-dir", root: projectDir };
        const identity = (await realpathOr(fallbackRoot)) ?? path.resolve(fallbackRoot);
        const fallbackPaths = managedPaths(identity, base);
        return unavailable(fallbackPaths, identity, undefined, "unavailable", `git could not report the repository: ${message(err)}`);
    }
    if (!toplevel)
        return { status: "project-dir", root: projectDir };
    // The developer toplevel is only migration input. Identity is the canonical
    // Git common directory: two linked developer worktrees of one repository must
    // resolve to the same managed store.
    const repository = await realpathOr(toplevel);
    if (!repository)
        return { status: "project-dir", root: projectDir };
    const commonDir = await gitCommonDir(repository, git);
    const identity = commonDir ?? repository;
    const paths = managedPaths(identity, base);
    const interval = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    const key = paths.ownerDir;
    const cached = cache.get(key);
    // An incomplete-refresh marker outranks the timing cache: a cached root must
    // never bypass recovery of a potentially partial checkout.
    const markerPending = await refreshMarkerPending(paths);
    if (!markerPending && !opts.forceRefresh && cached && interval > 0 && Date.now() - cached.at < interval) {
        return cached.result;
    }
    const running = inflight.get(key);
    if (running)
        return running;
    const job = (async () => {
        let result;
        try {
            result = await withProjectStoreAccess(storeAccess(paths), () => initializeOrRefresh({ repository, identity, paths, git }));
        }
        catch (err) {
            // Serialization timed out or a lock I/O failed. A previous complete root
            // is the best answer *only* when no incomplete-refresh marker is pending:
            // a marker means that root may be partial and must not be exposed.
            const pendingNow = markerPending || (await refreshMarkerPending(paths).catch(() => true));
            if (!pendingNow && cached?.result.status === "managed")
                return cached.result;
            result = unavailable(paths, repository, commonDir ?? undefined, "unavailable", message(err));
        }
        cache.set(key, { at: Date.now(), result });
        return result;
    })();
    inflight.set(key, job);
    try {
        return await job;
    }
    finally {
        if (inflight.get(key) === job)
            inflight.delete(key);
    }
}
/** Clear the timing cache (tests only; runtime never needs it). */
export function resetProjectStoreCache() {
    cache.clear();
    inflight.clear();
    globalCache.clear();
    globalInflight.clear();
}
/**
 * Refresh the global store clone in place with a fast-forward merge from the
 * remote default branch, serialized by the same cross-process lease family.
 *
 * The global store is a dedicated memory repository, not an application code
 * checkout. Still, the refresh is strictly non-destructive:
 * - If the directory is not a Git working tree, it is left as a plain folder.
 * - If tracked files have local changes, the current branch differs from the
 *   remote default branch, or the branch cannot be fast-forwarded, the refresh
 *   is skipped and the existing local clone stays usable.
 * - Untracked `.memory/` staging, audit state, and logs are untouched.
 */
export async function refreshGlobalStore(globalRoot, opts = {}) {
    const git = opts.git ?? defaultGitRun;
    const home = opts.home ?? os.homedir();
    const base = opts.base ? path.resolve(opts.base) : projectStoreBase(home);
    if ((await lstatKind(globalRoot)) !== "dir")
        return { root: globalRoot };
    const canonicalRoot = await realpathOr(globalRoot);
    if (!canonicalRoot)
        return { root: globalRoot };
    let toplevel = "";
    try {
        toplevel = (await git(["rev-parse", "--show-toplevel"], canonicalRoot)).trim();
    }
    catch {
        return { root: globalRoot };
    }
    if (!toplevel || !(await samePath(toplevel, canonicalRoot))) {
        return { root: globalRoot };
    }
    const commonDir = (await gitCommonDir(canonicalRoot, git)) ?? canonicalRoot;
    const access = {
        base,
        name: `global-${managedName(commonDir)}`,
        directRoot: canonicalRoot,
    };
    const interval = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    const key = `${access.base}:${access.name}`;
    const cached = globalCache.get(key);
    if (!opts.forceRefresh && cached && interval > 0 && Date.now() - cached.at < interval) {
        return { ...cached.result, root: globalRoot };
    }
    const running = globalInflight.get(key);
    if (running) {
        const settled = await running;
        return { ...settled, root: globalRoot };
    }
    const job = (async () => {
        await fs.mkdir(base, { recursive: true });
        let detail;
        try {
            detail = await withProjectStoreAccess(access, () => fastForwardGlobalClone(canonicalRoot, git));
        }
        catch (err) {
            detail = message(err);
        }
        const result = {
            root: globalRoot,
            access,
            ...(detail ? { detail } : {}),
        };
        globalCache.set(key, { at: Date.now(), result });
        return result;
    })();
    globalInflight.set(key, job);
    try {
        const settled = await job;
        return { ...settled, root: globalRoot };
    }
    finally {
        if (globalInflight.get(key) === job)
            globalInflight.delete(key);
    }
}
async function fastForwardGlobalClone(root, git) {
    if ((await lstatKind(root)) !== "dir")
        return "global store is not a real directory";
    let hasOrigin = false;
    try {
        hasOrigin = (await git(["remote", "get-url", "origin"], root)).trim().length > 0;
    }
    catch {
        return undefined;
    }
    if (!hasOrigin)
        return undefined;
    let ref;
    try {
        ref = await resolveDefaultRef(root, git);
    }
    catch (err) {
        return `global refresh skipped: ${message(err)}`;
    }
    // Never fast-forward over tracked modifications or while detached on a custom commit.
    const dirty = (await git(["status", "--porcelain", "-uno"], root).catch(() => "dirty")).trim();
    if (dirty !== "")
        return "global refresh skipped: tracked files have local changes";
    const branch = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], root).catch(() => "")).trim();
    const expectedBranch = ref.startsWith("origin/") ? ref.slice("origin/".length) : "";
    if (!branch || (expectedBranch && branch !== expectedBranch)) {
        return "global refresh skipped: global clone is not on its default branch";
    }
    const current = await headSha(root, git);
    const target = await commitSha(root, git, ref);
    if (!target || current === target)
        return undefined;
    try {
        await git(["merge", "--ff-only", "--quiet", target], root);
        return undefined;
    }
    catch (err) {
        return `global refresh skipped: ${message(err)}`;
    }
}
// ─── Initialization / refresh (inside the cross-process lease) ──────────────
async function initializeOrRefresh(input) {
    const { repository, identity, paths, git } = input;
    await fs.mkdir(paths.base, { recursive: true });
    // Boundary first: a symlinked owner/worktree path is refused before any read
    // that could follow it, and long before any destructive command.
    const boundary = await assertManagedBoundary(paths);
    if (!boundary.ok)
        return unavailable(paths, repository, identity, "unproven", boundary.detail);
    const read = await readManifest(paths, identity);
    if (read.kind === "invalid" || read.kind === "mismatch") {
        return unavailable(paths, repository, identity, "unproven", read.detail);
    }
    let manifest;
    if (read.kind === "ok") {
        manifest = read.manifest;
    }
    else {
        const claim = await canClaimOwnerDir(paths.ownerDir);
        if (!claim.ok)
            return unavailable(paths, repository, identity, "unproven", claim.detail);
        await fs.mkdir(paths.ownerDir, { recursive: true });
        manifest = {
            owner: "opencode-plugin-memory",
            version: 1,
            repository: identity,
            worktree: paths.worktree,
            base: paths.ownerDir,
            createdAt: new Date().toISOString(),
        };
        await writeManifest(paths, manifest);
    }
    // Crash recovery outranks any cached/managed result: a marker means an
    // earlier refresh may have died between sparse/reset and verification.
    const pending = await readRefreshMarker(paths);
    if (pending.kind === "invalid") {
        // Unusable marker: drop it only under the proven owner boundary, then let a
        // normal refresh establish and verify the target before exposing the root.
        await removeRefreshMarker(paths);
    }
    else if (pending.kind === "valid") {
        const recovered = await recoverInterruptedRefresh(paths, repository, identity, git, manifest, pending.marker);
        if (recovered)
            return recovered;
        // No worktree to recover: fall through to normal creation.
    }
    const afterRecovery = await assertManagedBoundary(paths);
    if (!afterRecovery.ok)
        return unavailable(paths, repository, identity, "unproven", afterRecovery.detail);
    if (await isOwnedWorktree(paths.worktree, repository, identity, git)) {
        // Both proofs are required on every refresh, not only during recovery.
        const marker = await readWorktreeMarker(paths.worktree, identity, paths);
        if (!marker.ok || marker.kind !== "ok") {
            return unavailable(paths, repository, identity, "unproven", marker.ok ? "worktree ownership marker is missing" : marker.detail);
        }
        return refreshExistingWorktree(paths, repository, identity, git, manifest);
    }
    return createWorktree(paths, repository, identity, git, manifest);
}
/** Refresh an already-verified managed worktree through the crash-safe transaction. */
async function refreshExistingWorktree(paths, repository, identity, git, manifest) {
    const ref = await resolveDefaultRef(repository, git, manifest.defaultRef).catch(() => null);
    const target = ref ? await commitSha(repository, git, ref) : null;
    if (!ref || !target) {
        // Keep the last complete checkout: a fetch/ref failure is not a reason to
        // drop to the developer directory or to blank the index.
        return managed(paths, repository, identity, "refresh failed; keeping the last complete managed checkout");
    }
    const previous = await headSha(paths.worktree, git);
    const applied = await applyRefreshTransaction(paths, repository, identity, git, previous, target);
    if (!applied.ok)
        return applied.resolution;
    await restorePendingState(paths);
    // A failed bookkeeping write never invalidates a checkout that was just
    // verified; the next refresh retries the flag.
    await persistRefreshState(paths, repository, manifest, ref).catch(() => undefined);
    return managed(paths, repository, identity, applied.detail);
}
/** Create the managed worktree, then apply the target commit transactionally. */
async function createWorktree(paths, repository, identity, git, manifest) {
    const prepared = await prepareForWorktreeAdd(paths, identity);
    if (!prepared.ok)
        return unavailable(paths, repository, identity, "unproven", prepared.detail);
    let ref;
    let target;
    try {
        ref = await resolveDefaultRef(repository, git);
        target = await commitSha(repository, git, ref);
    }
    catch (err) {
        await restorePendingState(paths);
        return unavailable(paths, repository, identity, "unavailable", message(err));
    }
    if (!target) {
        await restorePendingState(paths);
        return unavailable(paths, repository, identity, "unavailable", "could not resolve the target commit");
    }
    try {
        // `--force` re-creates a checkout whose directory was removed while its
        // registration remained. It is reached only after the manifest proved this
        // path belongs to this repository, and the path is absent or empty.
        await git(["worktree", "add", "--force", "--no-checkout", "--detach", paths.worktree, target], repository);
    }
    catch (err) {
        await restorePendingState(paths);
        return unavailable(paths, repository, identity, "unavailable", message(err));
    }
    if (!(await isOwnedWorktree(paths.worktree, repository, identity, git))) {
        await restorePendingState(paths);
        return unavailable(paths, repository, identity, "unproven", "the new worktree could not be verified as this repository's");
    }
    await writeWorktreeMarker(paths.worktree, identity);
    const applied = await applyRefreshTransaction(paths, repository, identity, git, null, target);
    if (!applied.ok)
        return applied.resolution;
    await restorePendingState(paths);
    await persistRefreshState(paths, repository, manifest, ref).catch(() => undefined);
    return managed(paths, repository, identity, applied.detail);
}
/**
 * Apply `target` under an on-disk transaction marker. The marker is written
 * before the first mutating command; on failure it is repaired or rolled back
 * while the lease is still held. A target that cannot be verified is never
 * exposed as `managed`.
 */
async function applyRefreshTransaction(paths, repository, identity, git, previous, target) {
    await writeRefreshMarker(paths, { identity, worktree: paths.worktree, previousHead: previous, targetHead: target });
    if (await applyTarget(paths, repository, identity, git, target)) {
        await removeRefreshMarker(paths);
        return { ok: true };
    }
    // One repair attempt (sparse/reset can fail transiently, e.g. a concurrently
    // fetched object), then a plain verification in case the failure happened
    // before any mutation, then roll back to the last verified commit.
    if (await applyTarget(paths, repository, identity, git, target)) {
        await removeRefreshMarker(paths);
        return { ok: true };
    }
    if (await verifyManagedWorktree(paths, repository, identity, git, target)) {
        await removeRefreshMarker(paths);
        return { ok: true };
    }
    if (previous && previous !== target && (await applyTarget(paths, repository, identity, git, previous))) {
        await removeRefreshMarker(paths);
        return { ok: true, detail: "refresh failed; rolled back to the previous managed checkout" };
    }
    return {
        ok: false,
        resolution: unavailable(paths, repository, identity, "unavailable", "refresh could not be completed or rolled back; the managed checkout is marked incomplete until a later retry"),
    };
}
/** Sparse-checkout + hard reset to an immutable commit, then verify. */
async function applyTarget(paths, repository, identity, git, target) {
    // Every destructive command is preceded by all three proofs: real paths at
    // the deterministic boundary, both ownership documents, and an exact
    // registered detached linked worktree.
    const boundary = await assertManagedBoundary(paths);
    if (!boundary.ok)
        return false;
    if (!(await isOwnedWorktree(paths.worktree, repository, identity, git)))
        return false;
    const marker = await readWorktreeMarker(paths.worktree, identity, paths);
    if (!marker.ok || marker.kind !== "ok")
        return false;
    try {
        await ensureSparseCheckout(paths.worktree, git);
        await git(["reset", "--hard", target], paths.worktree);
    }
    catch {
        return false;
    }
    return verifyManagedWorktree(paths, repository, identity, git, target);
}
/**
 * Postcondition of a successful mutation: registered linked worktree, detached
 * HEAD at `target`, sparse to `memory/`, and a clean tracked memory tree.
 */
async function verifyManagedWorktree(paths, repository, identity, git, target) {
    if (!(await isOwnedWorktree(paths.worktree, repository, identity, git)))
        return false;
    const marker = await readWorktreeMarker(paths.worktree, identity, paths);
    if (!marker.ok || marker.kind !== "ok")
        return false;
    try {
        const head = (await git(["rev-parse", "HEAD"], paths.worktree)).trim();
        if (head !== target)
            return false;
        const attached = (await git(["symbolic-ref", "-q", "HEAD"], paths.worktree).catch(() => "")).trim();
        if (attached)
            return false;
        const patterns = (await git(["sparse-checkout", "list"], paths.worktree)).split(/\r?\n/).filter(Boolean);
        if (!patterns.includes(MEMORY_SPARSE_PATTERN))
            return false;
        const dirty = (await git(["status", "--porcelain", "-uno", "--", "memory"], paths.worktree)).trim();
        return dirty === "";
    }
    catch {
        return false;
    }
}
/**
 * Recover a refresh that died after mutating the worktree. Under the lease,
 * repair to the recorded target; failing that, roll back to the recorded
 * previous commit; both are verified. If neither verifies, the marker stays and
 * the store is unavailable.
 */
async function recoverInterruptedRefresh(paths, repository, identity, git, manifest, marker) {
    if (marker.identity !== identity || marker.worktree !== paths.worktree) {
        return unavailable(paths, repository, identity, "unproven", "incomplete-refresh marker belongs to another repository or path");
    }
    const kind = await lstatKind(paths.worktree);
    if (kind === "missing") {
        // Nothing partial is exposed; a normal creation can proceed.
        await removeRefreshMarker(paths);
        return null;
    }
    if (kind !== "dir") {
        return unavailable(paths, repository, identity, "unproven", "managed worktree is not a real directory");
    }
    if (!(await isOwnedWorktree(paths.worktree, repository, identity, git))) {
        return unavailable(paths, repository, identity, "unproven", "an interrupted refresh left an unverifiable worktree");
    }
    if (await applyTarget(paths, repository, identity, git, marker.targetHead)) {
        await removeRefreshMarker(paths);
        await persistRefreshState(paths, repository, manifest, manifest.defaultRef ?? marker.targetHead).catch(() => undefined);
        return managed(paths, repository, identity, "recovered an interrupted refresh to its target commit");
    }
    if (marker.previousHead && (await applyTarget(paths, repository, identity, git, marker.previousHead))) {
        await removeRefreshMarker(paths);
        await persistRefreshState(paths, repository, manifest, manifest.defaultRef ?? marker.previousHead).catch(() => undefined);
        return managed(paths, repository, identity, "rolled back an interrupted refresh to the previous commit");
    }
    return unavailable(paths, repository, identity, "unavailable", "an interrupted refresh could not be repaired or rolled back; the store stays unavailable");
}
/**
 * Record a successful refresh and run the one-time migration of old
 * machine-local state. Untracked `.memory/` is untouched by `reset --hard`, so
 * staged proposals and audit state survive every refresh.
 */
async function persistRefreshState(paths, repository, manifest, ref) {
    manifest.defaultRef = ref;
    manifest.refreshedAt = new Date().toISOString();
    if (!manifest.legacyStateMigratedAt) {
        // Best effort: an unreadable old runtime folder must not take the managed
        // store down. Only a completed copy is recorded as done.
        try {
            await copyLegacyRuntimeState(repository, paths.worktree);
            manifest.legacyStateMigratedAt = manifest.refreshedAt;
        }
        catch {
            // retried on the next successful refresh
        }
    }
    // Every successful refresh is recorded (the timestamp is part of the
    // evidence), not only when another field happens to change.
    await writeManifest(paths, manifest);
}
// ─── Boundary, refresh marker, commit helpers ───────────────────────────────
/**
 * The owner directory and worktree must be real directories whose real paths
 * stay exactly at `<base>/<name>` and `<base>/<name>/worktree`. A symlink or any
 * other indirection is refused before a read can follow it and long before a
 * destructive command can target it.
 */
async function assertManagedBoundary(paths) {
    const realBase = (await realpathOr(paths.base)) ?? path.resolve(paths.base);
    const ownerKind = await lstatKind(paths.ownerDir);
    if (ownerKind === "missing") {
        if ((await lstatKind(paths.worktree)) !== "missing") {
            return { ok: false, detail: "managed worktree exists without an owner directory" };
        }
        return { ok: true };
    }
    if (ownerKind === "symlink")
        return { ok: false, detail: "owner directory is a symlink" };
    if (ownerKind !== "dir")
        return { ok: false, detail: "owner directory is not a real directory" };
    const realOwner = await realpathOr(paths.ownerDir);
    if (!realOwner || path.dirname(realOwner) !== realBase || path.basename(realOwner) !== paths.name) {
        return { ok: false, detail: "owner directory resolves outside its deterministic location" };
    }
    const worktreeKind = await lstatKind(paths.worktree);
    if (worktreeKind === "missing")
        return { ok: true };
    if (worktreeKind === "symlink")
        return { ok: false, detail: "managed worktree is a symlink" };
    if (worktreeKind !== "dir")
        return { ok: false, detail: "managed worktree is not a real directory" };
    const realWorktree = await realpathOr(paths.worktree);
    if (!realWorktree || realWorktree !== path.join(realOwner, WORKTREE_DIR)) {
        return { ok: false, detail: "managed worktree resolves outside its owner directory" };
    }
    return { ok: true };
}
async function lstatKind(target) {
    try {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink())
            return "symlink";
        return stat.isDirectory() ? "dir" : "other";
    }
    catch (err) {
        if (errorCode(err) === "ENOENT")
            return "missing";
        throw err;
    }
}
function refreshMarkerPath(paths) {
    return path.join(paths.ownerDir, REFRESH_MARKER_FILE);
}
/** Cheap existence check; used to keep a cached root from bypassing recovery. */
export async function refreshMarkerPending(paths) {
    try {
        await fs.lstat(refreshMarkerPath(paths));
        return true;
    }
    catch (err) {
        return errorCode(err) !== "ENOENT";
    }
}
async function readRefreshMarker(paths) {
    let text;
    try {
        text = await fs.readFile(refreshMarkerPath(paths), "utf8");
    }
    catch (err) {
        if (errorCode(err) === "ENOENT")
            return { kind: "missing" };
        return { kind: "invalid", detail: `incomplete-refresh marker is unreadable: ${message(err)}` };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { kind: "invalid", detail: "incomplete-refresh marker is not valid JSON" };
    }
    if (!parsed || typeof parsed !== "object")
        return { kind: "invalid", detail: "incomplete-refresh marker is incomplete" };
    const o = parsed;
    const previousHead = o["previousHead"];
    if (o["owner"] !== "opencode-plugin-memory" ||
        o["version"] !== 1 ||
        typeof o["identity"] !== "string" ||
        typeof o["worktree"] !== "string" ||
        typeof o["targetHead"] !== "string" ||
        !(previousHead === null || typeof previousHead === "string") ||
        typeof o["startedAt"] !== "string") {
        return { kind: "invalid", detail: "incomplete-refresh marker is incomplete" };
    }
    return {
        kind: "valid",
        marker: {
            owner: "opencode-plugin-memory",
            version: 1,
            identity: o["identity"],
            worktree: o["worktree"],
            previousHead: previousHead ?? null,
            targetHead: o["targetHead"],
            startedAt: o["startedAt"],
        },
    };
}
/** Persist the transaction marker before the first mutating command. */
async function writeRefreshMarker(paths, marker) {
    const payload = {
        owner: "opencode-plugin-memory",
        version: 1,
        identity: marker.identity,
        worktree: marker.worktree,
        previousHead: marker.previousHead,
        targetHead: marker.targetHead,
        startedAt: new Date().toISOString(),
    };
    const target = refreshMarkerPath(paths);
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
    await fs.rename(tmp, target);
}
async function removeRefreshMarker(paths) {
    await fs.rm(refreshMarkerPath(paths), { force: true });
}
/** Immutable commit SHA for a ref resolved in the developer repository. */
async function commitSha(repository, git, ref) {
    try {
        const sha = (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repository)).trim();
        return sha || null;
    }
    catch {
        return null;
    }
}
/** Current HEAD SHA of the managed worktree, or null when it has none. */
async function headSha(worktree, git) {
    try {
        const sha = (await git(["rev-parse", "--verify", "--quiet", "HEAD"], worktree)).trim();
        return sha || null;
    }
    catch {
        return null;
    }
}
async function readManifest(paths, repository) {
    let text;
    try {
        text = await fs.readFile(paths.manifestFile, "utf8");
    }
    catch (err) {
        if (errorCode(err) === "ENOENT")
            return { kind: "missing" };
        return { kind: "invalid", detail: `ownership manifest is unreadable: ${message(err)}` };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { kind: "invalid", detail: "ownership manifest is not valid JSON" };
    }
    if (!isManifest(parsed))
        return { kind: "invalid", detail: "ownership manifest is incomplete" };
    if (parsed.repository !== repository || parsed.worktree !== paths.worktree || parsed.base !== paths.ownerDir) {
        return { kind: "mismatch", detail: "ownership manifest belongs to a different repository or path" };
    }
    return { kind: "ok", manifest: parsed };
}
function isManifest(value) {
    if (!value || typeof value !== "object")
        return false;
    const o = value;
    return (o["owner"] === "opencode-plugin-memory" &&
        o["version"] === 1 &&
        typeof o["repository"] === "string" &&
        typeof o["worktree"] === "string" &&
        typeof o["base"] === "string" &&
        typeof o["createdAt"] === "string");
}
async function writeManifest(paths, manifest) {
    await fs.mkdir(path.dirname(paths.manifestFile), { recursive: true });
    const tmp = `${paths.manifestFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await fs.rename(tmp, paths.manifestFile);
}
async function writeWorktreeMarker(worktree, repository) {
    const marker = {
        owner: "opencode-plugin-memory",
        version: 1,
        repository,
        worktree,
        createdAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(worktree, WORKTREE_MARKER), JSON.stringify(marker, null, 2) + "\n", "utf8");
}
/**
 * An owner directory may be claimed only when it is absent or empty. Anything
 * already inside it (including another checkout) is left for a human: a name is
 * not proof of ownership.
 */
async function canClaimOwnerDir(ownerDir) {
    let stat;
    try {
        stat = await fs.lstat(ownerDir);
    }
    catch (err) {
        if (errorCode(err) === "ENOENT")
            return { ok: true };
        return { ok: false, detail: `owner directory is unreadable: ${message(err)}` };
    }
    if (!stat.isDirectory())
        return { ok: false, detail: "owner directory path is not a directory" };
    const entries = await fs.readdir(ownerDir);
    if (entries.length === 0)
        return { ok: true };
    return { ok: false, detail: "owner directory exists without an ownership manifest" };
}
/**
 * Prove that `worktree` is *exactly* a linked worktree of this repository:
 * a real (non-symlink) directory, registered in `git worktree list --porcelain`
 * for the developer repository, detached, and sharing the canonical common
 * directory `identity`. Reads only; a failure means "not proven", so no reset
 * is run.
 */
async function isOwnedWorktree(worktree, repository, identity, git) {
    if ((await lstatKind(worktree)) !== "dir")
        return false;
    try {
        const top = (await git(["rev-parse", "--show-toplevel"], worktree)).trim();
        if (!top || !(await samePath(top, worktree)))
            return false;
        const common = (await git(["rev-parse", "--git-common-dir"], worktree)).trim();
        if (!common)
            return false;
        const commonAbs = path.isAbsolute(common) ? common : path.resolve(worktree, common);
        if (!(await samePath(commonAbs, identity)))
            return false;
        // Registration: the developer repository must list this exact path, and the
        // entry must be detached (no branch checked out).
        const listing = await git(["worktree", "list", "--porcelain"], repository);
        const entries = await worktreeEntries(listing);
        let found;
        for (const entry of entries) {
            if (await samePath(entry.path, worktree)) {
                found = entry;
                break;
            }
        }
        if (!found || found.branch !== undefined)
            return false;
        return true;
    }
    catch {
        return false;
    }
}
/** Parse `git worktree list --porcelain` into entries. */
async function worktreeEntries(text) {
    const entries = [];
    let current = null;
    for (const line of text.split(/\r?\n/)) {
        if (line === "") {
            if (current)
                entries.push(current);
            current = null;
            continue;
        }
        if (line.startsWith("worktree ")) {
            if (current)
                entries.push(current);
            current = { path: line.slice("worktree ".length) };
            continue;
        }
        if (!current)
            continue;
        if (line.startsWith("HEAD "))
            current.head = line.slice("HEAD ".length);
        else if (line.startsWith("branch "))
            current.branch = line.slice("branch ".length);
    }
    if (current)
        entries.push(current);
    return entries;
}
/**
 * Make `worktree` ready for `git worktree add`.
 *
 * Nothing is moved or removed unless *both* proofs agree: the owner manifest
 * (already validated by the caller) and the worktree marker inside the
 * directory. A missing or mismatched marker is refused untouched, so a
 * directory that merely shares our naming scheme is never repaired.
 */
async function prepareForWorktreeAdd(paths, identity) {
    const boundary = await assertManagedBoundary(paths);
    if (!boundary.ok)
        return { ok: false, detail: boundary.detail };
    let stat;
    try {
        stat = await fs.lstat(paths.worktree);
    }
    catch (err) {
        if (errorCode(err) === "ENOENT")
            return { ok: true };
        return { ok: false, detail: `managed worktree path is unreadable: ${message(err)}` };
    }
    if (!stat.isDirectory())
        return { ok: false, detail: "managed worktree path is not a directory" };
    const entries = await fs.readdir(paths.worktree);
    if (entries.length === 0) {
        await fs.rmdir(paths.worktree);
        return { ok: true };
    }
    const unexpected = entries.filter((name) => name !== ".memory" && name !== WORKTREE_MARKER);
    if (unexpected.length > 0) {
        return { ok: false, detail: "managed worktree path holds files this plugin did not create" };
    }
    const marker = await readWorktreeMarker(paths.worktree, identity, paths);
    if (!marker.ok)
        return { ok: false, detail: marker.detail };
    // A directory with runtime state but no marker cannot be proven to be ours.
    if (entries.includes(".memory") && marker.kind === "missing") {
        return { ok: false, detail: "runtime state exists without a worktree ownership marker" };
    }
    const pending = path.join(paths.ownerDir, PENDING_STATE_DIR);
    if (await exists(pending))
        return { ok: false, detail: "recovery state from an earlier attempt already exists" };
    if (entries.includes(".memory")) {
        await fs.rename(path.join(paths.worktree, ".memory"), pending);
    }
    if (entries.includes(WORKTREE_MARKER)) {
        await fs.rm(path.join(paths.worktree, WORKTREE_MARKER), { force: true });
    }
    await fs.rmdir(paths.worktree);
    return { ok: true };
}
/** Parse and validate the marker inside a worktree against repository/path. */
async function readWorktreeMarker(worktree, identity, paths) {
    let text;
    try {
        text = await fs.readFile(path.join(worktree, WORKTREE_MARKER), "utf8");
    }
    catch (err) {
        if (errorCode(err) === "ENOENT")
            return { ok: true, kind: "missing" };
        return { ok: false, detail: `worktree ownership marker is unreadable: ${message(err)}` };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { ok: false, detail: "worktree ownership marker is not valid JSON" };
    }
    if (!parsed || typeof parsed !== "object") {
        return { ok: false, detail: "worktree ownership marker is incomplete" };
    }
    const o = parsed;
    if (o["owner"] !== "opencode-plugin-memory" || o["version"] !== 1) {
        return { ok: false, detail: "worktree ownership marker belongs to a different owner" };
    }
    if (o["repository"] !== identity || o["worktree"] !== paths.worktree) {
        return { ok: false, detail: "worktree ownership marker belongs to a different repository or path" };
    }
    return { ok: true, kind: "ok" };
}
/** Move recovered runtime state back into a freshly created worktree. */
async function restorePendingState(paths) {
    const pending = path.join(paths.ownerDir, PENDING_STATE_DIR);
    if (!(await exists(pending)))
        return;
    const dest = path.join(paths.worktree, ".memory");
    if (!(await exists(dest))) {
        // A failed `worktree add` may have left no directory; create the parent so
        // recovered state is never stranded outside the store.
        await fs.mkdir(paths.worktree, { recursive: true });
        await fs.rename(pending, dest);
        return;
    }
    await mergeStateDir(pending, dest);
    await fs.rm(pending, { recursive: true, force: true });
}
/**
 * Merge `src` into `dest` without overwriting anything or following symlinks:
 * only regular files at the top level and inside `staging/` are copied. Lock
 * files and temporary writes are skipped.
 */
async function mergeStateDir(src, dest) {
    await fs.mkdir(dest, { recursive: true });
    for (const name of await fs.readdir(src)) {
        const from = path.join(src, name);
        if (name === "staging") {
            await mergeStaging(from, path.join(dest, "staging"));
            continue;
        }
        if (name.endsWith(".lock") || name.endsWith(".tmp"))
            continue;
        if (await isRegularFile(from))
            await copyNoClobber(from, path.join(dest, name));
    }
}
async function mergeStaging(src, dest) {
    let entries;
    try {
        entries = await fs.readdir(src);
    }
    catch {
        return;
    }
    await fs.mkdir(dest, { recursive: true });
    for (const name of entries) {
        if (name.endsWith(".lock") || name.endsWith(".tmp"))
            continue;
        const from = path.join(src, name);
        if (!(name.startsWith("mem-") && (await isRegularFile(from))))
            continue;
        await copyNoClobber(from, path.join(dest, name));
    }
}
async function copyNoClobber(from, to) {
    try {
        await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
    }
    catch (err) {
        if (errorCode(err) === "EEXIST")
            return;
        throw err;
    }
}
/**
 * One-time copy of the previous machine-local project state from the developer
 * checkout (`.memory/staging`, `.memory/audit-state.json`) into the managed
 * store. Lock files are excluded; existing managed files are never overwritten.
 * The legacy tree is left in place.
 */
export async function copyLegacyRuntimeState(repository, worktree) {
    const source = path.join(repository, ".memory");
    if (!(await exists(source)))
        return;
    const dest = path.join(worktree, ".memory");
    await fs.mkdir(dest, { recursive: true });
    for (const name of await fs.readdir(source)) {
        const from = path.join(source, name);
        if (name === "staging") {
            await mergeStaging(from, path.join(dest, "staging"));
            continue;
        }
        if (name === "audit-state.json" && (await isRegularFile(from))) {
            await copyNoClobber(from, path.join(dest, name));
        }
    }
}
// ─── Git helpers ────────────────────────────────────────────────────────────
/**
 * The ref the managed worktree should track: the remote's default branch.
 *
 * The remote's *currently advertised* HEAD wins over a local
 * `refs/remotes/origin/HEAD`, which is only set at clone time and goes stale
 * when the remote changes its default branch. Fetch is best effort: when the
 * remote cannot be queried, the last local default ref (or the last ref this
 * store used) still refreshes offline.
 */
async function resolveDefaultRef(repository, git, lastRef) {
    let hasOrigin = false;
    try {
        hasOrigin = (await git(["remote", "get-url", "origin"], repository)).length > 0;
    }
    catch {
        hasOrigin = false;
    }
    if (hasOrigin) {
        await git(["fetch", "--quiet", "origin"], repository).catch(() => "");
        // 1. Ask the remote what its default branch is right now.
        try {
            const remote = await git(["ls-remote", "--symref", "origin", "HEAD"], repository);
            const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(remote);
            if (match?.[1]) {
                const candidate = `origin/${match[1]}`;
                if (await refExists(repository, git, candidate))
                    return candidate;
            }
        }
        catch {
            // remote unreachable or not advertising a symbolic HEAD
        }
        // 2. Offline fallbacks: the local remote HEAD, then the conventional names,
        //    then the ref this store last followed.
        try {
            const defined = (await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repository)).trim();
            if (defined && (await refExists(repository, git, defined)))
                return defined;
        }
        catch {
            // no local origin/HEAD
        }
        for (const candidate of ["origin/main", "origin/master"]) {
            if (await refExists(repository, git, candidate))
                return candidate;
        }
        if (lastRef && (await refExists(repository, git, lastRef)))
            return lastRef;
        // A repository with a remote must follow that remote's default branch; a
        // developer's checked-out branch is never silently substituted.
        throw new Error("could not determine the remote default branch");
    }
    // Local-only repository: there is no remote default branch to follow.
    if (await refExists(repository, git, "HEAD"))
        return "HEAD";
    throw new Error("could not determine a ref to check out");
}
/**
 * Canonical Git common directory (realpath) for a developer checkout. Used as
 * the managed-store identity so linked worktrees of one repository share a
 * single store. Returns null when Git cannot report it.
 */
async function gitCommonDir(repository, git) {
    try {
        const raw = (await git(["rev-parse", "--git-common-dir"], repository)).trim();
        if (!raw)
            return null;
        const abs = path.isAbsolute(raw) ? raw : path.resolve(repository, raw);
        return (await realpathOr(abs)) ?? abs;
    }
    catch {
        return null;
    }
}
async function refExists(repository, git, ref) {
    try {
        await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repository);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Keep the sparse pattern `memory/` only. Runs on every refresh (cheap, no
 * network) so a worktree whose sparse config was lost never materializes source.
 */
async function ensureSparseCheckout(worktree, git) {
    try {
        const patterns = (await git(["sparse-checkout", "list"], worktree)).split(/\r?\n/).filter(Boolean);
        if (patterns.length === 1 && patterns[0] === MEMORY_SPARSE_PATTERN)
            return;
    }
    catch {
        // sparse checkout not enabled
    }
    await git(["sparse-checkout", "set", "--no-cone", MEMORY_SPARSE_PATTERN], worktree);
}
// ─── Shared cross-process access lease ─────────────────────────────────────
/** Lease descriptor for a managed store, carried on `Store.access`. */
export function storeAccess(paths) {
    return { base: paths.base, name: paths.name };
}
/**
 * Take the shared access lease for managed-store filesystem operations.
 * Global and plain-directory stores do not call this (their Store has no
 * `access`), so they stay no-ops behind `withStoreAccess`.
 */
export async function withProjectStoreAccess(access, fn) {
    const release = await acquireLease(access);
    try {
        return await fn();
    }
    finally {
        await release();
    }
}
/** True when a managed store carries an incomplete-refresh marker. */
export async function pendingRefreshForAccess(access) {
    try {
        await fs.lstat(path.join(access.base, access.name, REFRESH_MARKER_FILE));
        return true;
    }
    catch (err) {
        return errorCode(err) !== "ENOENT";
    }
}
/**
 * Re-check, at consumer time, that the access descriptor still points at the
 * real managed owner/worktree. A cache hit must not let a swapped symlink send
 * reads or writes into the developer checkout.
 */
export async function assertAccessBoundary(access) {
    if (access.directRoot) {
        const kind = await lstatKind(access.directRoot);
        if (kind !== "dir")
            return { ok: false, detail: "global store is not a real directory" };
        const real = await realpathOr(access.directRoot);
        if (!real || real !== access.directRoot) {
            return { ok: false, detail: "global store resolves outside its canonical location" };
        }
        return { ok: true };
    }
    const ownerDir = path.join(access.base, access.name);
    const worktree = path.join(ownerDir, WORKTREE_DIR);
    const realBase = (await realpathOr(access.base)) ?? path.resolve(access.base);
    const ownerKind = await lstatKind(ownerDir);
    if (ownerKind !== "dir")
        return { ok: false, detail: "owner directory is not a real directory" };
    const realOwner = await realpathOr(ownerDir);
    if (!realOwner || path.dirname(realOwner) !== realBase || path.basename(realOwner) !== access.name) {
        return { ok: false, detail: "owner directory resolves outside its deterministic location" };
    }
    const worktreeKind = await lstatKind(worktree);
    if (worktreeKind !== "dir")
        return { ok: false, detail: "managed worktree is not a real directory" };
    const realWorktree = await realpathOr(worktree);
    if (!realWorktree || realWorktree !== path.join(realOwner, WORKTREE_DIR)) {
        return { ok: false, detail: "managed worktree resolves outside its owner directory" };
    }
    return { ok: true };
}
function leasePath(access) {
    return path.join(access.base, LOCK_DIR, `${access.name}.lock`);
}
/**
 * How a lease directory/file is read: the owner token, or "" for malformed
 * ownership (missing/empty/unreadable). Symlinks are never followed.
 */
async function readLeaseOwner(target) {
    const kind = await lstatKind(target);
    if (kind === "missing")
        return null;
    if (kind === "symlink")
        return "";
    if (kind === "dir") {
        const owner = path.join(target, LEASE_OWNER_FILE);
        const ownerKind = await lstatKind(owner);
        if (ownerKind === "symlink" || ownerKind === "dir" || ownerKind === "missing")
            return "";
        return (await fs.readFile(owner, "utf8").catch(() => "")).trim();
    }
    // Legacy single-file lock: read the token directly.
    return (await fs.readFile(target, "utf8").catch(() => "")).trim();
}
/**
 * Acquire the lease by publishing a fully formed owner token atomically: write
 * a unique temp directory, then rename it onto the canonical path. A stale
 * owner (dead PID or malformed token) is renamed to a unique tombstone before
 * removal, so a newly acquired canonical lease can never be deleted by a slow
 * competitor. A live PID is never considered stale by age.
 */
async function acquireLease(access) {
    const dir = path.join(access.base, LOCK_DIR);
    await fs.mkdir(dir, { recursive: true });
    const canonical = leasePath(access);
    const token = `${process.pid}:${Date.now()}:${crypto.randomBytes(6).toString("hex")}`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        const tmp = path.join(dir, `.${access.name}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
        await fs.mkdir(tmp);
        try {
            await fs.writeFile(path.join(tmp, LEASE_OWNER_FILE), token, "utf8");
            await fs.rename(tmp, canonical);
            return makeRelease(canonical, token);
        }
        catch (err) {
            await fs.rm(tmp, { recursive: true, force: true });
            const code = errorCode(err);
            // Contended: a non-empty canonical lease is in the way. Anything else is
            // an environment failure the caller must see.
            if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM" && code !== "ENOTDIR")
                throw err;
        }
        const seen = await readLeaseOwner(canonical);
        if (seen === null)
            continue; // released between our attempt and the read
        if (lockIsStale(seen)) {
            await takeOverStale(canonical, dir, access.name, seen);
            continue;
        }
        if (Date.now() > deadline) {
            throw new StoreAccessError("The project memory store is busy: another session or a refresh holds it. Try again in a moment.");
        }
        await sleep(LOCK_POLL_MS);
    }
}
function makeRelease(canonical, token) {
    return async () => {
        const current = await readLeaseOwner(canonical);
        if (current !== token)
            return;
        // Move our own lease aside before deleting it, so a concurrently acquired
        // lease is never the thing that gets removed.
        const tomb = `${canonical}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.release`;
        try {
            await fs.rename(canonical, tomb);
        }
        catch {
            return;
        }
        const moved = await readLeaseOwner(tomb);
        if (moved === token)
            await fs.rm(tomb, { recursive: true, force: true });
        else
            await fs.rename(tomb, canonical).catch(() => undefined);
    };
}
/**
 * Move a lease judged stale to a unique tombstone and delete only that. If the
 * canonical lease changed hands between our read and the rename, put the fresh
 * owner's lease back untouched.
 */
async function takeOverStale(canonical, dir, name, seen) {
    const tomb = path.join(dir, `.${name}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.dead`);
    try {
        await fs.rename(canonical, tomb);
    }
    catch {
        return; // another process took over or released first
    }
    const moved = await readLeaseOwner(tomb);
    if (moved !== seen) {
        // A fresh live owner slipped in; restore its lease and leave it alone.
        await fs.rename(tomb, canonical).catch(() => undefined);
        return;
    }
    await fs.rm(tomb, { recursive: true, force: true });
}
/**
 * Whether a lease's owner may be displaced.
 *
 * Only an unparseable token or a dead owner is stale. Age alone never expires a
 * live owner: a slow fetch is not a crashed process, and stealing its lease
 * would let two processes reset the same worktree at once.
 */
export function lockIsStale(content, alive = pidAlive) {
    const [pidText, tsText] = content.split(":");
    const pid = Number(pidText);
    const ts = Number(tsText);
    if (!(pid > 0) || !Number.isFinite(ts))
        return true;
    return !alive(pid);
}
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return errorCode(err) === "EPERM";
    }
}
// ─── Utilities ──────────────────────────────────────────────────────────────
function managed(paths, repository, commonDir, detail) {
    const result = {
        status: "managed",
        root: paths.worktree,
        repository,
        commonDir,
        managedRoot: paths.ownerDir,
    };
    if (detail)
        result.detail = detail;
    return result;
}
function unavailable(paths, repository, commonDir, problem, detail) {
    const result = {
        status: "unavailable",
        root: paths.worktree,
        repository,
        managedRoot: paths.ownerDir,
        problem,
        detail,
    };
    if (commonDir)
        result.commonDir = commonDir;
    return result;
}
/**
 * Nearest directory containing a `.git` entry (directory or worktree file),
 * walking upwards. Used only when Git itself cannot answer, so a broken/missing
 * Git never turns a repository checkout into a runtime store.
 */
async function findGitRoot(start) {
    let current = path.resolve(start);
    for (;;) {
        if (await exists(path.join(current, ".git")))
            return current;
        const parent = path.dirname(current);
        if (parent === current)
            return null;
        current = parent;
    }
}
async function realpathOr(target) {
    try {
        return await fs.realpath(target);
    }
    catch {
        return null;
    }
}
async function samePath(a, b) {
    const [ra, rb] = await Promise.all([realpathOr(a), realpathOr(b)]);
    if (ra && rb)
        return ra === rb;
    return path.resolve(a) === path.resolve(b);
}
async function exists(target) {
    try {
        await fs.lstat(target);
        return true;
    }
    catch {
        return false;
    }
}
async function isRegularFile(target) {
    try {
        const stat = await fs.lstat(target);
        return stat.isFile() && !stat.isSymbolicLink();
    }
    catch {
        return false;
    }
}
function errorCode(err) {
    return err instanceof Error && "code" in err ? err.code : undefined;
}
function message(err) {
    return err instanceof Error ? err.message : String(err);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=projectStore.js.map