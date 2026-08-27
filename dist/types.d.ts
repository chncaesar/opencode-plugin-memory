/**
 * A single persisted memory entry in MEMORY.md
 */
export type MemoryEntry = {
    /** Stable ID, e.g. MEM-001 */
    id: string;
    /** One-line title shown in the summary */
    title: string;
    /** Full content body (may be multi-line) */
    content: string;
    /** ISO date string, e.g. 2026-08-26 */
    added: string;
    /** ISO date string when last modified */
    updated?: string;
    /** Optional free-form tags for grouping */
    tags?: string[];
    /** Whether this entry is soft-deleted (moved to Archived section) */
    archived: boolean;
};
/**
 * The full parsed state of a MEMORY.md file
 */
export type MemoryStore = {
    entries: MemoryEntry[];
    /** Next sequence number to assign (used to generate IDs) */
    nextSeq: number;
};
/**
 * Plugin configuration (user-provided via opencode.json plugin options)
 */
export type PluginConfig = {
    /**
     * Maximum number of characters injected into the system prompt summary.
     * Approximate token budget: 1 token ≈ 4 chars, so default 2000 chars ≈ 500 tokens.
     * @default 2000
     */
    maxSummaryChars: number;
    /**
     * Enable writing an operation log to .opencode/memory/plugin.log.
     * Records every add/update/delete and all errors.
     * @default true
     */
    enableLog: boolean;
};
export declare const DEFAULT_CONFIG: PluginConfig;
//# sourceMappingURL=types.d.ts.map