import type { MemoryEntry, MemoryStore } from "./types.js";
export type Relation = "duplicate" | "refinement" | "contradiction";
export declare const RELATIONS: readonly Relation[];
export type Finding = {
    /** Sorted entry IDs involved, e.g. ["MEM-001", "MEM-004"] */
    ids: string[];
    relation: Relation;
    /** One-line reason from the auditing model */
    reason: string;
    /** Hash of the involved entries at audit time */
    hash: string;
};
export type Dismissal = {
    /** Item key, see findingKey() */
    key: string;
    /** Hash of the involved entries when dismissed */
    hash: string;
};
export type ReviewState = {
    version: 1;
    /** ISO timestamp of the last completed (or attempted) audit; "" if never */
    lastAuditAt: string;
    /** Hash of all active entries when the last audit completed; "" if never */
    lastHash: string;
    findings: Finding[];
    dismissed: Dismissal[];
};
export declare function emptyReviewState(): ReviewState;
export declare function reviewFilePath(projectDir: string): string;
/** Stable hash of the given entries' text (order-independent). */
export declare function hashEntries(entries: MemoryEntry[]): string;
export declare function activeEntries(store: MemoryStore): MemoryEntry[];
export declare function hashActive(store: MemoryStore): string;
/** Read review.json; a missing or corrupt file yields an empty state. */
export declare function readReviewState(projectDir: string): Promise<ReviewState>;
/** Write review.json atomically (temp file + rename) so readers never see a partial file. */
export declare function writeReviewState(projectDir: string, state: ReviewState): Promise<void>;
/** Entries that look like leftovers, detected by explicit markers only (no similarity). */
export declare function findPlaceholders(store: MemoryStore): MemoryEntry[];
export type AgingEntry = {
    entry: MemoryEntry;
    ageDays: number;
};
/** Active entries whose latest of added/updated is older than staleDays, oldest first. */
export declare function findAging(store: MemoryStore, staleDays: number, now?: Date): AgingEntry[];
/** Key identifying a reviewable item; used for dismissals. */
export declare function findingKey(ids: string[]): string;
export type AttentionItem = {
    kind: "audit";
    key: string;
    finding: Finding;
} | {
    kind: "placeholder";
    key: string;
    entry: MemoryEntry;
};
/**
 * Items the LLM should look at: audit findings whose entries are all still
 * active and unchanged, and placeholder entries, minus anything dismissed
 * against the current text.
 */
export declare function collectAttention(store: MemoryStore, state: ReviewState): AttentionItem[];
export type DismissOutcome = {
    state: ReviewState;
    dismissed: string[];
    unknown: string[];
};
/**
 * Record "keep both / keep as is" for the given item keys. Unknown keys (not a
 * current attention item) are reported and ignored.
 */
export declare function dismissItems(store: MemoryStore, state: ReviewState, keys: string[]): DismissOutcome;
/** Drop dismissals and findings that no longer match any entry text. */
export declare function pruneState(store: MemoryStore, state: ReviewState): ReviewState;
/** One-line hint for the system prompt; empty string when nothing needs attention. */
export declare function nudgeLine(items: AttentionItem[]): string;
export declare function clip(text: string, max: number): string;
export declare function formatReview(store: MemoryStore, items: AttentionItem[], aging: AgingEntry[], staleDays: number, auditInfo: {
    lastAuditAt: string;
    enabled: boolean;
}): string;
//# sourceMappingURL=review.d.ts.map