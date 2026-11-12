#!/usr/bin/env node
import type { Memory } from "./types.js";
/** The repository's default branch (main/master), used as the PR base. */
export declare function defaultBranch(cwd: string): Promise<string>;
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
    base: string;
    branch: string;
    title: string;
    body: string;
};
export type BotOptions = {
    /** Repository root used for git commands (defaults to the project dir). */
    cwd?: string;
    /** Log a line; defaults to console.error. */
    log?: (line: string) => void;
    /** Open a PR and return its URL. Defaults to `gh pr create`. Injectable for tests. */
    openPr?: (req: PrRequest) => Promise<string>;
};
export type BotResult = {
    /** Number of staged proposals successfully turned into PRs. */
    promoted: number;
    /** Number of staged proposals left in place (branch already existed, nothing to change). */
    skipped: number;
    /** Number of staged proposals whose git/PR step failed; left in place for the next run. */
    failed: number;
    /** URLs of the PRs opened by this run. */
    prs: string[];
    /** True when another bot run held the lock, so nothing was processed. */
    busy?: boolean;
};
/**
 * Process every staged proposal once. All git work happens in a throwaway git
 * worktree, so the developer's checkout (branch, index, uncommitted files) is
 * never touched. For each proposal:
 *   1. skip if a branch `memory/<id>` already exists (PR already opened);
 *   2. branch off the fetched default branch in the worktree, apply the
 *      transform, commit, push, open PR;
 *   3. on success remove the staged file; on failure leave it for the next run.
 */
export declare function processStagingOnce(projectDir: string, opts?: BotOptions): Promise<BotResult>;
/** Poll staging forever, processing new proposals as they appear. */
export declare function startWatch(projectDir: string, intervalMs: number, opts?: BotOptions): Promise<void>;
//# sourceMappingURL=bot.d.ts.map