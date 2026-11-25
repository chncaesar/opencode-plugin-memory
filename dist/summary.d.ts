import { type StoreReadProblem } from "./storage.js";
import type { Memory, Scope } from "./types.js";
import { type StoreSet } from "./stores.js";
/** One store's contribution to the prompt, already read (or known unreadable). */
export type ScopeListing = {
    scope: Scope;
    memories: Memory[];
    /** Readable entries skipped because their file was unreadable or invalid. */
    omitted: number;
    /** The folder itself could not be listed, so an empty list means failure, not absence. */
    unavailable: boolean;
};
export type PromptInput = {
    global?: ScopeListing;
    project: ScopeListing;
    /** Path-free notice shown in place of the global index when that store is unusable. */
    globalNotice?: string;
    /** Path-free notice shown in place of the project index when that store is unusable. */
    projectNotice?: string;
    /** Path-free warning that a legacy MEMORY.md was found and automatic import is deferred. */
    legacyNotice?: string;
};
/**
 * One `[mem-XXXX] Title` line per memory, ordered by id so the prompt is stable
 * across runs. Titles and ids only: full bodies stay on disk and load lazily
 * through `memory_read`.
 */
export declare function buildIndexLines(memories: Memory[]): string[];
/**
 * Build the block injected into every system prompt: the introduction, the
 * global index, the project index, and the writing policy.
 *
 * Budget: `maxChars` is shared. The project store keeps at least
 * `1 - share` of it reserved, so a large global store cannot push project
 * entries out of the prompt entirely; budget the project store does not need
 * is available to the global store, and vice versa. A truncated section says so
 * and points at `memory_read`.
 */
export declare function buildSystemPrompt(input: PromptInput, maxChars: number, share: number): string;
/**
 * Called once per prompt build with the entries that were skipped, so the host
 * can log them without putting a filesystem message in the prompt. The callback
 * must not throw; a failing reporter never fails the prompt.
 */
export type IndexProblemReporter = (problems: StoreReadProblem[]) => void | Promise<void>;
/**
 * Prompt block for a session, derived from both stores on every call.
 *
 * Reading is tolerant by design: a normal conversation must not fail because a
 * store is unreadable, one entry file is corrupt, or a folder is a file.
 * Unreadable entries are skipped and reported through `onProblems`; a store
 * that cannot be listed falls back to an unavailable notice. Raw filesystem
 * errors never reach the prompt.
 */
export declare function loadPromptBlock(stores: StoreSet, maxChars: number, share: number, onProblems?: IndexProblemReporter, opts?: {
    legacyImportDeferred?: boolean;
}): Promise<string>;
//# sourceMappingURL=summary.d.ts.map