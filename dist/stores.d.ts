import type { PluginConfig, Scope } from "./types.js";
import { StoreAccessError, type GlobalStoreOptions, type ProjectStoreAccess, type ProjectStoreOptions, type ProjectStoreProblem } from "./projectStore.js";
export { StoreAccessError };
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
    /**
     * Cross-process access lease for a managed Git project store. Absent for the
     * global store and for non-Git project directories, so `withStoreAccess` is a
     * no-op there.
     */
    access?: ProjectStoreAccess;
};
/** Why the global store is not usable this session. */
export type GlobalProblem = "disabled" | "missing" | "not-directory" | "unreadable";
export type StoreSet = {
    /** Present only when the global store is readable. */
    global?: Store;
    /**
     * Always present. For a Git project this is the plugin-managed worktree, not
     * the developer checkout; for a plain directory it is the session directory.
     */
    project: Store;
    /**
     * Where the project's own files are read for input (legacy migration): the
     * repository toplevel for a Git project, the session directory otherwise.
     * Never a runtime store root.
     */
    projectInputRoot?: string;
    /** True when the project store is the plugin-managed Git checkout. */
    projectManaged?: boolean;
    /** Scope a proposal receives when it does not name one. */
    defaultScope: Scope;
    /** Configured location of the global store, resolved (whether or not it exists). */
    globalPath: string;
    /** Absent when the global store is available. */
    globalProblem?: GlobalProblem;
    /**
     * Set only when the project is a Git project but its managed store could not
     * be created or proven. The developer checkout is never substituted.
     */
    projectProblem?: ProjectStoreProblem;
};
/** Expand a leading `~` (or `~/`); anything else is returned unchanged. */
export declare function expandHome(value: string, home?: string): string;
/** Absolute path of the global store on this machine. */
export declare function globalStorePath(config: PluginConfig, home?: string): string;
export type DirProbe = (root: string) => Promise<"dir" | "missing" | "other">;
/**
 * Resolve which stores this session may use.
 *
 * The project store is resolved through the managed-worktree manager: a Git
 * project gets one persistent plugin-owned checkout outside the developer's
 * working tree, and a plain directory keeps the session directory as its root.
 * A Git project whose managed store cannot be used is reported through
 * `projectProblem`; it is never replaced by the developer checkout.
 *
 * The global store is used only when enabled and its folder exists: a missing
 * clone, a path that is a file, or an unreadable folder degrades to project-only
 * memory, never to a broken session. Probes and Git execution are injectable so
 * tests never touch the real stores.
 */
export declare function resolveStores(projectDir: string, config: PluginConfig, opts?: {
    home?: string;
    probe?: DirProbe;
    /** Internal test injection for the managed project store. */
    project?: ProjectStoreOptions;
    /** Internal test injection for the global store refresh. */
    global?: GlobalStoreOptions;
}): Promise<StoreSet>;
/**
 * The project store, or `null` when the managed store could not be created or
 * proven. Callers must treat `null` as "unknown, unavailable" — never as an
 * empty store — and must not write through it.
 */
export declare function usableProjectStore(stores: StoreSet): Store | null;
/** True when the project store may be read or written this session. */
export declare function projectStoreUsable(stores: StoreSet): boolean;
/**
 * Stores that may be read or written, global first. An unavailable project
 * store is omitted, so no consumer can read it as empty or write into it.
 */
export declare function availableStores(stores: StoreSet): Store[];
/**
 * Run a complete filesystem operation against a store under its cross-process
 * access lease. Managed project stores serialize with refresh; the global store
 * and plain-directory project stores have no lease and simply run `fn`.
 *
 * A pending incomplete-refresh marker makes the consumer fail closed: the store
 * must be recovered by a resolve before anyone reads or writes it.
 */
export declare function withStoreAccess<T>(store: Store, fn: () => Promise<T>): Promise<T>;
/**
 * One line for the system prompt. Path-free, like the global notice: the model
 * only needs to know the project store is unavailable and that project writes
 * are disabled, not where the machine keeps it.
 */
export declare function projectProblemPrompt(problem: ProjectStoreProblem): string;
/**
 * The same condition as an instruction a human can act on. Used by the memory
 * tools, where the concrete path is useful and the system prompt stays clean.
 */
export declare function projectProblemToolMessage(problem: ProjectStoreProblem, root: string): string;
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