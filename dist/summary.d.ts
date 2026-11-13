import type { Memory } from "./types.js";
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
 */
export declare function buildSystemPrompt(memories: Memory[], maxChars: number): string;
/** Prompt block for a project, derived from its active memories on every call. */
export declare function loadMemoryBlock(projectDir: string, maxChars: number): Promise<string>;
//# sourceMappingURL=summary.d.ts.map