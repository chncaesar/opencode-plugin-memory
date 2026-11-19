import { type StoreReadProblem } from "./storage.js";
import type { Memory } from "./types.js";
export type SystemPromptOptions = {
    /** Replace the index entirely: the store could not be listed. */
    indexUnavailable?: boolean;
    /** Readable memories skipped because their file was unreadable or invalid. */
    omitted?: number;
};
/**
 * Build the index shown to the model: one `[mem-XXXX] Title` line per active
 * memory, ordered by id so the prompt is stable across runs. The index is
 * always derived from `memory/active/`; nothing is read from or written to a
 * prebuilt index file.
 */
export declare function buildIndexLines(memories: Memory[]): string[];
/**
 * Build the block injected into every system prompt: the memory-system
 * introduction, the index (titles and ids only, never full bodies), and the
 * complete writing policy. Full bodies stay on disk and load lazily through
 * `memory_read`, so a large store costs only one line per memory per turn.
 *
 * `options.indexUnavailable` replaces the index when the store could not be
 * listed; `options.omitted` is the number of memory files skipped because they
 * were unreadable or invalid, so the model knows the list may be incomplete.
 */
export declare function buildSystemPrompt(memories: Memory[], maxChars: number, options?: SystemPromptOptions): string;
/**
 * Called once per prompt build with the entries that were skipped, so the host
 * can log them without putting a filesystem message in the prompt. The callback
 * must not throw; a failing reporter never fails the prompt.
 */
export type IndexProblemReporter = (problems: StoreReadProblem[]) => void | Promise<void>;
/**
 * Prompt block for a project, derived from its active memories on every call.
 *
 * Reading the store is tolerant by design: a normal conversation must not fail
 * because `memory/active/` is unreadable, one entry file is corrupt, or the
 * folder is a file. Unreadable entries are skipped and reported through
 * `onProblems`; when the folder itself cannot be read, the block falls back to
 * the writing policy with an index-unavailable notice. Raw filesystem errors
 * never reach the prompt.
 */
export declare function loadMemoryBlock(projectDir: string, maxChars: number, onProblems?: IndexProblemReporter): Promise<string>;
//# sourceMappingURL=summary.d.ts.map