import type { Memory } from "./types.js";
/**
 * Build the committed index: one line per active memory, `[mem-XXXX] Title`,
 * ordered deterministically (by id) so regeneration is stable across runs.
 */
export declare function buildSummaryContent(memories: Memory[]): string;
/**
 * Regenerate `memory/_summary.md` from the active memories. Called by migration
 * and later by CI on merge. Never called when proposing (proposals must stay
 * invisible until merged).
 */
export declare function generateSummary(projectDir: string): Promise<void>;
/**
 * Read the committed index; empty string when it does not exist.
 */
export declare function readSummaryContent(projectDir: string): Promise<string>;
/** Extract just the `[mem-XXXX] Title` lines from raw summary content. */
export declare function extractIndexLines(content: string): string[];
/**
 * Build the block injected into every system prompt: the memory-system
 * introduction, the committed index (titles and ids only, never full bodies),
 * and the complete writing policy. `summaryContent` is the raw `_summary.md`.
 */
export declare function buildSystemPrompt(summaryContent: string, maxChars: number): string;
//# sourceMappingURL=summary.d.ts.map