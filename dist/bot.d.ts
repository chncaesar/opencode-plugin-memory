#!/usr/bin/env node
import { type ProjectStoreOptions } from "./projectStore.js";
import type { Memory } from "./types.js";
/**
 * `owner/repo` (or `host/owner/repo` for non-github.com hosts) of a git remote
 * URL, in the form `gh --repo` accepts. Undefined for local paths and anything
 * that is not a hosted `owner/repo` URL.
 */
export declare function parseRemoteUrl(url: string): string | undefined;
/** The repository's default branch (main/master), used as the PR base. */
export declare function defaultBranch(cwd: string, repo?: string): Promise<string>;
/** Thrown when a path the bot is about to touch is not the expected kind of entry. */
export declare class MemoryBoundaryError extends Error {
    constructor(message: string);
}
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
export declare function applyPropose(projectDir: string, memory: Memory): Promise<string[]>;
/**
 * Promote a `retire` proposal: move `memory/active/<id>` to `memory/retired/`
 * with the reason from the staged file. Does NOT remove the staged file.
 * Idempotent: a missing active file means it was already retired.
 *
 * Every touched path is validated before the first write, so a symlinked or
 * malformed entry is left for a human instead of being followed.
 */
export declare function applyRetire(projectDir: string, staged: Memory): Promise<string[]>;
export declare function buildPrTitle(memory: Memory): string;
export declare function buildPrBody(memory: Memory): string;
export type PrRequest = {
    cwd: string;
    repo?: string;
    base: string;
    branch: string;
    title: string;
    body: string;
};
export type PrLookup = {
    cwd: string;
    repo?: string;
    branch: string;
};
export type BotOptions = {
    /** Repository root used for git commands (defaults to the project dir). */
    cwd?: string;
    /** Log a line; defaults to console.error. */
    log?: (line: string) => void;
    /** Open a PR and return its URL. Defaults to `gh pr create`. Injectable for tests. */
    openPr?: (req: PrRequest) => Promise<string>;
    /** Find an existing PR (any state) for a branch; its URL, or null. Defaults to `gh pr list`. */
    findPr?: (req: PrLookup) => Promise<string | null>;
};
export type BotResult = {
    /** Number of staged proposals successfully turned into PRs. */
    promoted: number;
    /** Number of staged proposals left in place (nothing to change). */
    skipped: number;
    /**
     * Number of staged proposals that could not be published and were left in
     * place: either the git/PR step failed, or the file failed the boundary
     * preflight (symlink, wrong entry type, name/id mismatch, bad reference).
     */
    failed: number;
    /** Proposals whose branch was already pushed by an earlier run; their PR was found or opened now. */
    recovered: number;
    /** URLs of the PRs opened or found by this run. */
    prs: string[];
    /** True when another bot run held the lock, so nothing was processed. */
    busy?: boolean;
};
/** `gh pr create` arguments; `--repo` pins the PR to the repo we push to. */
export declare function buildPrCreateArgs(req: PrRequest): string[];
/** `gh pr list` arguments that find a PR in any state for a head branch. */
export declare function buildPrListArgs(req: PrLookup): string[];
/**
 * Branch for a proposal. A retire proposal carries the id of the memory it
 * retires, which already has an add branch (`memory/<id>`) that is usually kept
 * after merge, so retires get their own namespace, made unique per proposal by
 * its proposal time (stable across retries of the same proposal).
 */
export declare function branchFor(memory: Memory): string;
/**
 * Take the single-run lock; returns a release function, or null when another
 * live, recent run holds it. The lock file appears atomically with its full
 * content (written to a temp file, then hard-linked into place), so a reader
 * never sees an empty or partial lock. A stale lock is removed only if it is
 * unchanged since it was judged stale; two processes racing to take over the
 * same stale lock can still both win in a very narrow window.
 */
export declare function acquireLock(projectDir: string): Promise<(() => Promise<void>) | null>;
/**
 * One publish run, with the machine-local publish record kept around it.
 *
 * Every caller — the standalone `once`/`watch` commands and the in-plugin
 * `memory_publish` tool — goes through here, so a failure is recorded exactly
 * once and is identical in both paths.
 *
 * The record never changes the run's outcome:
 * - a failed result (including rejected staged files) persists the reason;
 * - a thrown error is recorded and rethrown unchanged;
 * - a run that verified there is nothing left to publish clears an older
 *   failure;
 * - a busy run records nothing, because it did not verify anything.
 *
 * Recording is best effort (see publishState.ts): it must not throw, and it must
 * not replace the outcome or error the caller would otherwise see.
 */
export declare function processStagingOnce(projectDir: string, opts?: BotOptions): Promise<BotResult>;
/** Where the CLI's store root came from. */
export type CliStoreSource = "managed" | "project-dir" | "explicit";
/** The store a CLI run will publish from, and how it was chosen. */
export type CliStoreTarget = {
    /** Absolute root the bot publishes from. */
    root: string;
    /**
     * `managed` — the plugin-managed worktree of this Git repository;
     * `project-dir` — the directory itself, when it is not a Git project and is
     * therefore its own store; `explicit` — a store root named by `--dir`.
     */
    source: CliStoreSource;
    /** Developer toplevel the managed store belongs to (source `managed` only). */
    repository?: string;
};
/**
 * One phrase naming the store a run checked. The CLI must never claim "no staged
 * proposals" without saying which store it looked at: the same words for a
 * developer checkout and for its managed store would hide the fact that the
 * agent's proposals live in the other one.
 */
export declare function describeCliStore(target: CliStoreTarget): string;
/**
 * Resolve the store the CLI should process, and how it was chosen.
 *
 * - An explicit `--dir <path>` is an explicit store selection: it must already
 *   exist and hold `.memory/` or `memory/` (see `explicitStoreDir`). It is used
 *   exactly as given — never remapped to another directory.
 * - An omitted `--dir` resolves the current directory through the managed
 *   project-store manager. A Git project uses its managed worktree; a plain
 *   directory stays its own store, which is the plugin's historical behaviour
 *   for non-Git projects. The source is returned so the CLI can name it.
 * - A Git project whose managed store cannot be initialized still refuses: its
 *   developer checkout is never a substitute.
 */
export declare function resolveCliStoreTarget(cwd: string, dirArg?: string, opts?: ProjectStoreOptions): Promise<CliStoreTarget>;
/**
 * The store root only, kept for callers of the original signature. Use
 * `resolveCliStoreTarget` when the CLI needs to name the store it checked.
 */
export declare function resolveCliStoreDir(cwd: string, dirArg?: string, opts?: ProjectStoreOptions): Promise<string>;
/** Poll staging forever, processing new proposals as they appear. */
export declare function startWatch(projectDir: string, intervalMs: number, opts?: BotOptions): Promise<void>;
//# sourceMappingURL=bot.d.ts.map