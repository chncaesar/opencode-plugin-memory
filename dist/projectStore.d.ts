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
export declare const MANAGED_BASE_SEGMENTS: readonly [".local", "share", "opencode", "project-memory"];
/** Ownership manifest inside the owner directory (outside the worktree). */
export declare const MANIFEST_FILE = "owner.json";
/** Directory inside the owner directory that holds the actual worktree. */
export declare const WORKTREE_DIR = "worktree";
/** Ownership marker carried inside the worktree itself (untracked by Git). */
export declare const WORKTREE_MARKER = ".memory-owner.json";
/** Incomplete-refresh transaction marker, outside the worktree. */
export declare const REFRESH_MARKER_FILE = "refresh.json";
/** Minimum time between two refreshes of the same managed store. */
export declare const DEFAULT_REFRESH_INTERVAL_MS = 30000;
/** Run Git with the given arguments in `cwd`; resolves trimmed stdout, rejects on failure. */
export type GitRun = (args: string[], cwd: string) => Promise<string>;
export declare const defaultGitRun: GitRun;
export type ProjectStoreState = "managed" | "project-dir" | "unavailable";
export type ProjectStoreProblem = "unavailable" | "unproven";
export type ProjectStoreResolution = {
    /** `managed` — the plugin worktree is usable; `project-dir` — not a Git project; `unavailable` — a Git project whose managed store could not be used. */
    status: ProjectStoreState;
    /** The single root the store uses. For `unavailable` this is the managed path, never the developer checkout. */
    root: string;
    /** Absolute (realpath) developer toplevel, used as migration input for a Git project. */
    repository?: string;
    /**
     * Canonical Git common directory used as this repository's identity. Two
     * linked developer worktrees share it, so they converge on one managed store.
     */
    commonDir?: string;
    /** Owner directory of the managed store (manifest + worktree). */
    managedRoot?: string;
    /** Present only when `status === "unavailable"`. */
    problem?: ProjectStoreProblem;
    /** Diagnostic detail; never shown in the system prompt. */
    detail?: string;
};
export type ProjectStoreOptions = {
    /** Home directory the base path is derived from (tests inject a temp home). */
    home?: string;
    /** Absolute base directory override (tests inject a temp base). */
    base?: string;
    /** Minimum milliseconds between refreshes. `0` refreshes on every call. */
    refreshIntervalMs?: number;
    /** Refresh now, ignoring the timing cache. */
    forceRefresh?: boolean;
    /** Git runner override (tests simulate failures). */
    git?: GitRun;
};
/**
 * The cross-process lease of one managed store. Carried on `Store.access` so
 * every consumer of the store root (prompt index, tools, audit, refresh) takes
 * the same lease.
 */
export type ProjectStoreAccess = {
    base: string;
    name: string;
};
/** Thrown when a consumer cannot take the lease, or must not read a recovering store. */
export declare class StoreAccessError extends Error {
    constructor(message: string);
}
export type ManagedPaths = {
    base: string;
    name: string;
    ownerDir: string;
    manifestFile: string;
    worktree: string;
};
/** Absolute base directory of all managed project stores. */
export declare function projectStoreBase(home?: string): string;
/**
 * Deterministic directory name for a repository: sanitized basename plus a hash
 * of the canonical path, so two checkouts with the same name never collide and
 * a moved checkout gets its own store.
 */
export declare function managedName(repository: string): string;
/** All paths of one managed store. */
export declare function managedPaths(repository: string, base: string): ManagedPaths;
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
export declare function resolveProjectStore(projectDir: string, opts?: ProjectStoreOptions): Promise<ProjectStoreResolution>;
/** Clear the timing cache (tests only; runtime never needs it). */
export declare function resetProjectStoreCache(): void;
/** Cheap existence check; used to keep a cached root from bypassing recovery. */
export declare function refreshMarkerPending(paths: ManagedPaths): Promise<boolean>;
/**
 * One-time copy of the previous machine-local project state from the developer
 * checkout (`.memory/staging`, `.memory/audit-state.json`) into the managed
 * store. Lock files are excluded; existing managed files are never overwritten.
 * The legacy tree is left in place.
 */
export declare function copyLegacyRuntimeState(repository: string, worktree: string): Promise<void>;
/** Lease descriptor for a managed store, carried on `Store.access`. */
export declare function storeAccess(paths: ManagedPaths): ProjectStoreAccess;
/**
 * Take the shared access lease for managed-store filesystem operations.
 * Global and plain-directory stores do not call this (their Store has no
 * `access`), so they stay no-ops behind `withStoreAccess`.
 */
export declare function withProjectStoreAccess<T>(access: ProjectStoreAccess, fn: () => Promise<T>): Promise<T>;
/** True when a managed store carries an incomplete-refresh marker. */
export declare function pendingRefreshForAccess(access: ProjectStoreAccess): Promise<boolean>;
/**
 * Re-check, at consumer time, that the access descriptor still points at the
 * real managed owner/worktree. A cache hit must not let a swapped symlink send
 * reads or writes into the developer checkout.
 */
export declare function assertAccessBoundary(access: ProjectStoreAccess): Promise<{
    ok: true;
} | {
    ok: false;
    detail: string;
}>;
/**
 * Whether a lease's owner may be displaced.
 *
 * Only an unparseable token or a dead owner is stale. Age alone never expires a
 * live owner: a slow fetch is not a crashed process, and stealing its lease
 * would let two processes reset the same worktree at once.
 */
export declare function lockIsStale(content: string, alive?: (pid: number) => boolean): boolean;
//# sourceMappingURL=projectStore.d.ts.map