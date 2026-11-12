#!/usr/bin/env node
import type { Memory } from "./types.js";
/**
 * `owner/repo` (or `host/owner/repo` for non-github.com hosts) of a git remote
 * URL, in the form `gh --repo` accepts. Undefined for local paths and anything
 * that is not a hosted `owner/repo` URL.
 */
export declare function parseRemoteUrl(url: string): string | undefined;
/** The repository's default branch (main/master), used as the PR base. */
export declare function defaultBranch(cwd: string, repo?: string): Promise<string>;
/**
 * Promote a `propose` proposal into `memory/active/`, retiring any superseded
 * memories. Does NOT remove the staged file (the orchestrator does that only
 * after the PR opens). Idempotent: re-running overwrites the active file and
 * skips supersede targets that are already gone.
 *
 * Returns the list of filesystem paths changed (for logging).
 */
export declare function applyPropose(projectDir: string, memory: Memory): Promise<string[]>;
/**
 * Promote a `retire` proposal: move `memory/active/<id>` to `memory/retired/`
 * with the reason from the staged file. Does NOT remove the staged file.
 * Idempotent: a missing active file means it was already retired.
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
    /** Number of staged proposals whose git/PR step failed; left in place for the next run. */
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
 * Process every staged proposal once. All git work happens in a throwaway git
 * worktree, so the developer's checkout (branch, index, uncommitted files) is
 * never touched. For each proposal:
 *   1. if its branch is already on the remote (an earlier run pushed it but did
 *      not finish), find its PR, or open one, and drop the staged file;
 *   2. otherwise branch off the fetched default branch in the worktree, apply
 *      the transform, commit, push, open PR, drop the staged file;
 *   3. on failure leave the staged file for the next run.
 */
export declare function processStagingOnce(projectDir: string, opts?: BotOptions): Promise<BotResult>;
/** Poll staging forever, processing new proposals as they appear. */
export declare function startWatch(projectDir: string, intervalMs: number, opts?: BotOptions): Promise<void>;
//# sourceMappingURL=bot.d.ts.map