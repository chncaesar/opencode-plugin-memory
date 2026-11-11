/**
 * The fixed vocabulary of retirement reasons. A retired memory carries one of
 * these in its frontmatter so the reason is machine-checkable.
 */
export declare const RETIRED_REASONS: readonly ["wrong", "stale", "useless", "superseded", "duplicate"];
export type RetiredReason = (typeof RETIRED_REASONS)[number];
/**
 * The intent carried by a staged proposal file, telling the bot what to do.
 * - `propose` — a new memory (optionally carrying `supersedes`).
 * - `retire` — remove an existing active memory (names the target `id`).
 */
export declare const INTENTS: readonly ["propose", "retire"];
export type Intent = (typeof INTENTS)[number];
/**
 * A single memory, self-describing via its frontmatter. State is positional:
 * the folder the file lives in (active / retired / staging) is its status, so
 * a memory object itself does not carry a status field.
 */
export type Memory = {
    /** Short random identifier, e.g. `mem-abc12345`. */
    id: string;
    /** One-line title shown in the index. */
    title: string;
    /** Full markdown body. */
    body: string;
    /** Optional free-form tags for grouping. */
    tags?: string[];
    /** The human whose session proposed the memory. */
    author?: string;
    /** Free text describing the session or change that produced it. */
    source?: string;
    /** ISO timestamp the memory was proposed. */
    proposedAt?: string;
    /** ISO timestamp a human approved (merged) the memory. */
    approvedAt?: string;
    /** Who approved (merged) the memory. */
    approvedBy?: string;
    /** IDs of active memories this one replaces. */
    supersedes?: string[];
    /** ID of the memory that replaced this one (retired memories only). */
    supersededBy?: string;
    /** ISO timestamp the memory was retired (retired memories only). */
    retiredAt?: string;
    /** Reason the memory was retired, from a fixed vocabulary. */
    retiredReason?: RetiredReason;
    /** Optional link to the code change that motivated a change-tied memory. */
    relatedPr?: string;
    /** For staged proposals: what the bot should do with this file. */
    intent?: Intent;
};
/**
 * Where a memory currently lives. Positional status; not stored on the file.
 */
export type MemoryStatus = "active" | "retired" | "staging";
/**
 * Plugin configuration (user-provided via opencode.json plugin options).
 */
export type PluginConfig = {
    /**
     * Maximum number of characters used by the injected memory index.
     * The fixed writing policy is injected separately.
     * @default 2000
     */
    maxSummaryChars: number;
    /**
     * Enable writing an operation log to `.memory/plugin.log`.
     * @default true
     */
    enableLog: boolean;
    /**
     * Days after which an active memory (by `approved_at` or `proposed_at`) is
     * listed as "aging" in `memory_review`. Informational only — the background
     * audit is the model-judged semantic check, not an age threshold.
     * @default 90
     */
    staleDays: number;
    /**
     * Run a background semantic audit (a small-model call) after a session goes
     * idle, looking for duplicate / refining / contradicting memories. Each
     * finding becomes a retirement proposal (which the bot turns into a PR).
     * @default true
     */
    backgroundAudit: boolean;
    /**
     * Minimum minutes between two background audits.
     * @default 1
     */
    auditIntervalMinutes: number;
};
export declare const DEFAULT_CONFIG: PluginConfig;
//# sourceMappingURL=types.d.ts.map