import type { PluginConfig, Scope } from "./types.js";
/**
 * A memory store: a directory laid out exactly like a project's `memory/`
 * folder, with `memory/active/`, `memory/retired/` and a machine-local
 * `.memory/staging/`. The same code reads, writes and publishes every store; a
 * store differs only in where it lives and who can see it.
 */
export type Store = {
    scope: Scope;
    /** Directory holding `memory/` and `.memory/`. */
    root: string;
};
/** Why the global store is not usable this session. */
export type GlobalProblem = "disabled" | "missing" | "not-directory" | "unreadable";
export type StoreSet = {
    /** Present only when the global store is readable. */
    global?: Store;
    /** Always present: the session directory is the project store root. */
    project: Store;
    /** Scope a proposal receives when it does not name one. */
    defaultScope: Scope;
    /** Configured location of the global store, resolved (whether or not it exists). */
    globalPath: string;
    /** Absent when the global store is available. */
    globalProblem?: GlobalProblem;
};
/** Expand a leading `~` (or `~/`); anything else is returned unchanged. */
export declare function expandHome(value: string, home?: string): string;
/** Absolute path of the global store on this machine. */
export declare function globalStorePath(config: PluginConfig, home?: string): string;
export type DirProbe = (root: string) => Promise<"dir" | "missing" | "other">;
/**
 * Resolve which stores this session may use.
 *
 * The project store is always available (it may be empty). The global store is
 * used only when enabled and its folder exists: a missing clone, a path that is
 * a file, or an unreadable folder degrades to project-only memory, never to a
 * broken session. Probes are injectable so tests never touch the real store.
 */
export declare function resolveStores(projectDir: string, config: PluginConfig, opts?: {
    home?: string;
    probe?: DirProbe;
}): Promise<StoreSet>;
/** Stores that may be read or written, global first. */
export declare function availableStores(stores: StoreSet): Store[];
/**
 * One line for the system prompt. Deliberately path-free: the prompt must not
 * carry machine paths, and the model only needs to know which store is in use.
 */
export declare function globalProblemPrompt(problem: GlobalProblem): string;
/**
 * The same condition as an instruction a human can act on. Used by the memory
 * tools, where the concrete path is useful and nothing is injected into the
 * prompt.
 */
export declare function globalProblemToolMessage(problem: GlobalProblem, globalPath: string): string;
//# sourceMappingURL=stores.d.ts.map