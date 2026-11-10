import type { MemoryEntry, MemoryStore } from "./types.js";
/**
 * Resolve the machine-local `.opencode/memory` directory for a given project
 * root. Holds the auto-generated files only (`memory_summary.md`, `review.json`,
 * `plugin.log`) — not the committable store.
 */
export declare function memoryDir(projectDir: string): string;
/**
 * Resolve the shared (committable) memory store directory. Defaults to
 * `.agents/memory`; `override` is a relative directory name (e.g. `"memory"`)
 * from the project root.
 */
export declare function storeDir(projectDir: string, override?: string): string;
/**
 * Validate a user-supplied `storeDir` override. Returns the value when it is a
 * non-empty relative path that stays inside the project root (no `..` segment,
 * not absolute); otherwise `undefined` (callers fall back to the default).
 */
export declare function validStoreDir(value: unknown): string | undefined;
export declare function memoryFilePath(projectDir: string, storeDirOverride?: string): string;
export declare function summaryFilePath(projectDir: string): string;
/**
 * Parse the raw MEMORY.md text into a MemoryStore.
 * Format contract:
 *
 *   # OpenCode Memory
 *   <!-- nextSeq: 3 -->
 *
 *   ## Active
 *
 *   ### [MEM-001] Title here
 *   - added: 2026-08-26
 *   - updated: 2026-08-27
 *   - tags: coding-style, workflow
 *   Body content (may span multiple lines).
 *
 *   ## Archived
 *
 *   ### [MEM-002] Old title
 *   - added: 2026-08-20
 *   - archived: true
 *   Old content.
 */
export declare function parseMemory(text: string): MemoryStore;
/**
 * Serialize a MemoryStore back into MEMORY.md text.
 */
export declare function serializeMemory(store: MemoryStore): string;
/**
 * Read and parse MEMORY.md, returning an empty store if the file does not exist.
 */
export declare function readStore(projectDir: string, storeDirOverride?: string): Promise<MemoryStore>;
/**
 * Thrown when the store cannot be written because its path is unwritable or
 * read-only (e.g. projectDir is `/` or a read-only filesystem). Carries a
 * clean, user-facing message; tools catch it and return that message instead of
 * surfacing a raw EACCES.
 */
export declare class StoreWriteError extends Error {
    constructor(message: string, cause?: unknown);
}
/**
 * Write the store back to MEMORY.md, creating the directory if needed.
 * Unwritable/read-only paths raise a descriptive StoreWriteError.
 */
export declare function writeStore(projectDir: string, store: MemoryStore, storeDirOverride?: string): Promise<void>;
/**
 * One-time migration: if the shared store file does not exist but the legacy
 * `.opencode/memory/MEMORY.md` does, move it into place (creating the target
 * directory first). No-op when the new file already exists or there is no
 * legacy file. Throws on unexpected I/O errors; callers log and swallow.
 */
export declare function migrateLegacyStore(projectDir: string, storeDirOverride?: string): Promise<void>;
/**
 * Add a new entry and return the assigned ID.
 */
export declare function addEntry(store: MemoryStore, title: string, content: string, tags?: string[]): {
    store: MemoryStore;
    id: string;
};
/**
 * Update an existing entry by ID.  Returns null if not found.
 */
export declare function updateEntry(store: MemoryStore, id: string, patch: {
    title?: string;
    content?: string;
    tags?: string[];
}): MemoryStore | null;
/**
 * Soft-delete an entry by ID (moves it to the Archived section).
 * Returns null if not found among active entries.
 *
 * `reason` is stored on the entry (collapsed to one line); `supersededBy`
 * links the entry to the one that replaced it.
 */
export declare function archiveEntry(store: MemoryStore, id: string, opts?: {
    reason?: string;
    supersededBy?: string;
}): MemoryStore | null;
export type SupersedeResult = {
    ok: true;
    store: MemoryStore;
    id: string;
    archivedIds: string[];
} | {
    ok: false;
    error: string;
    badIds: string[];
};
/**
 * Add a new entry and archive the entries it replaces, as one atomic change.
 *
 * Every ID in `supersedes` must be an active entry; otherwise nothing changes
 * and the offending IDs are reported. Duplicate IDs are collapsed.
 */
export declare function addSupersedingEntry(store: MemoryStore, title: string, content: string, tags: string[] | undefined, supersedes: string[]): SupersedeResult;
/**
 * Follow superseded_by links from an entry to the one that currently stands in
 * for it. Returns the last entry in the chain. Cycle-safe.
 */
export declare function resolveSuccessor(store: MemoryStore, id: string): MemoryEntry | undefined;
/**
 * Search active entries by keyword (case-insensitive match on title + content + tags).
 */
export declare function searchEntries(store: MemoryStore, query: string): MemoryEntry[];
//# sourceMappingURL=storage.d.ts.map