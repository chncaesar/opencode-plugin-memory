import type { MemoryEntry, MemoryStore } from "./types.js";
/**
 * Resolve the .opencode/memory directory for a given project root.
 */
export declare function memoryDir(projectDir: string): string;
export declare function memoryFilePath(projectDir: string): string;
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
export declare function readStore(projectDir: string): Promise<MemoryStore>;
/**
 * Write the store back to MEMORY.md, creating the directory if needed.
 */
export declare function writeStore(projectDir: string, store: MemoryStore): Promise<void>;
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
 * Returns null if not found.
 */
export declare function archiveEntry(store: MemoryStore, id: string): MemoryStore | null;
/**
 * Search active entries by keyword (case-insensitive match on title + content + tags).
 */
export declare function searchEntries(store: MemoryStore, query: string): MemoryEntry[];
//# sourceMappingURL=storage.d.ts.map