import { type Memory, type MemoryStatus } from "./types.js";
/** Machine-local `.memory` directory (staging + plugin.log). */
export declare function machineDir(projectDir: string): string;
/** The git-ignored folder the agent writes proposals into. */
export declare function stagingDir(projectDir: string): string;
/** The committed memory root (`memory/`), holding active/ and retired/. */
export declare function memoryRootDir(projectDir: string): string;
/** The committed active-memory directory. */
export declare function activeDir(projectDir: string): string;
/** The committed retired-memory directory. */
export declare function retiredDir(projectDir: string): string;
/** The old-ID → new-ID mapping written by migration. */
export declare function migrationFilePath(projectDir: string): string;
/** True when `value` is a well-formed memory id (`mem-` + 8 base64url chars). */
export declare function isMemoryId(value: string): boolean;
/**
 * Generate a collision-free random id: `mem-` + 8 chars from
 * `crypto.randomBytes(6).toString("base64url")`. No sequential counter.
 */
export declare function generateMemoryId(): string;
/** Serialize a memory into the full on-disk file text. */
export declare function serializeMemory(memory: Memory): string;
/** Read a single memory file; `null` if missing or invalid (bad/missing frontmatter). */
export declare function readMemoryFile(filePath: string): Promise<Memory | null>;
/**
 * Read a single memory file, refusing to follow a symlink at `filePath`.
 * Only the leaf is protected: parent directories are the caller's concern.
 * `null` when the file is missing, invalid, or a symlink (`ELOOP`).
 *
 * Used by the bot, which must not let a staged or committed path redirect a
 * read outside the memory store.
 */
export declare function readMemoryFileNoFollow(filePath: string): Promise<Memory | null>;
/** List merged (active) memories. */
export declare function listActiveMemories(projectDir: string): Promise<Memory[]>;
/** List retired memories. */
export declare function listRetiredMemories(projectDir: string): Promise<Memory[]>;
/** List the agent's staged proposals. */
export declare function listStagedProposals(projectDir: string): Promise<Memory[]>;
/** One skipped entry, described without a filesystem message. */
export type StoreReadProblem = {
    /** Absolute path of the folder or file that could not be read. */
    file: string;
    /** Short cause: an errno code ("EACCES", "EISDIR", …) or "invalid" for missing/bad frontmatter. */
    code: string;
};
/** Result of a tolerant read: what was readable, plus what was skipped. */
export type MemoryListing = {
    memories: Memory[];
    problems: StoreReadProblem[];
    /** True when the folder itself could not be listed, so the listing is empty by failure, not by absence. */
    folderUnreadable: boolean;
};
/**
 * Read the memories in `dir` without throwing. An unreadable folder yields an
 * empty listing with one problem; an unreadable or invalid entry is skipped and
 * reported while the remaining memories are still returned.
 */
export declare function readMemoriesTolerant(dir: string): Promise<MemoryListing>;
/** Tolerant read of the committed active store, for the prompt index. */
export declare function listActiveMemoriesForIndex(projectDir: string): Promise<MemoryListing>;
export type MemoryWithStatus = {
    memory: Memory;
    status: MemoryStatus;
};
/** Read one memory by id from active, then retired, then staging. */
export declare function readMemoryById(projectDir: string, id: string): Promise<MemoryWithStatus | null>;
/**
 * Thrown when a proposal cannot be written because its staging path is
 * unwritable or read-only. Carries a clean, user-facing message; tools catch it
 * and return that message instead of surfacing a raw EACCES.
 */
export declare class StoreWriteError extends Error {
    constructor(message: string, cause?: unknown);
}
/** Publish a complete memory file into `dir` (creating it). */
export declare function writeMemoryFile(dir: string, memory: Memory): Promise<void>;
/**
 * Write a proposal file to `.memory/staging/`. Unwritable/read-only paths raise
 * a descriptive StoreWriteError.
 */
export declare function writeProposal(projectDir: string, memory: Memory): Promise<void>;
/** Move an active memory to `retired/`. */
export declare function moveToRetired(projectDir: string, id: string): Promise<void>;
/** Move a retired memory back to `active/`. */
export declare function moveToActive(projectDir: string, id: string): Promise<void>;
export type GitConfigReader = (key: string, cwd: string) => Promise<string | null>;
/**
 * Resolve the author for a proposal: `git config user.name`, falling back to
 * `user.email`, then `"unknown"` on any failure. `read` is injectable for tests.
 */
export declare function resolveAuthor(cwd: string, read?: GitConfigReader): Promise<string>;
/**
 * Age of a memory in whole days, from the later of `approved_at`/`proposed_at`.
 * Returns `NaN` when there is no usable timestamp.
 */
export declare function memoryAge(memory: Memory, now: Date): number;
//# sourceMappingURL=storage.d.ts.map