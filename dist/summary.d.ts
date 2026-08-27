import type { MemoryStore } from "./types.js";
/**
 * Build the text content for memory_summary.md from active entries,
 * truncated to at most maxChars characters.
 *
 * The summary is intentionally compact so it can be injected into every
 * system prompt with minimal token cost.  Entries are ordered newest-first
 * (by "added" date) so the most recent knowledge survives truncation.
 */
export declare function buildSummary(store: MemoryStore, maxChars: number): string;
/**
 * Write the summary file to disk, creating the directory if needed.
 */
export declare function writeSummary(projectDir: string, store: MemoryStore, maxChars: number): Promise<void>;
/**
 * Read the current summary file, returning an empty string if it does not exist.
 */
export declare function readSummary(projectDir: string): Promise<string>;
//# sourceMappingURL=summary.d.ts.map