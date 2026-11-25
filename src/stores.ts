import fs from "fs/promises"
import os from "os"
import path from "path"
import type { PluginConfig, Scope } from "./types.js"
import {
  assertAccessBoundary,
  pendingRefreshForAccess,
  refreshGlobalStore,
  resolveProjectStore,
  StoreAccessError,
  withProjectStoreAccess,
  type GlobalStoreOptions,
  type ProjectStoreAccess,
  type ProjectStoreOptions,
  type ProjectStoreProblem,
} from "./projectStore.js"

export { StoreAccessError }

/**
 * A memory store: a directory laid out exactly like a project's `memory/`
 * folder, with `memory/active/`, `memory/retired/` and a machine-local
 * `.memory/staging/`. The same code reads, writes and publishes every store; a
 * store differs only in where it lives and who can see it.
 */
export type Store = {
  scope: Scope
  /** Directory holding `memory/` and `.memory/`. */
  root: string
  /**
   * Cross-process access lease for a managed Git project store. Absent for the
   * global store and for non-Git project directories, so `withStoreAccess` is a
   * no-op there.
   */
  access?: ProjectStoreAccess
}

/** Why the global store is not usable this session. */
export type GlobalProblem = "disabled" | "missing" | "not-directory" | "unreadable"

export type StoreSet = {
  /** Present only when the global store is readable. */
  global?: Store
  /**
   * Always present. For a Git project this is the plugin-managed worktree, not
   * the developer checkout; for a plain directory it is the session directory.
   */
  project: Store
  /**
   * Where the project's own files are read for input (legacy migration): the
   * repository toplevel for a Git project, the session directory otherwise.
   * Never a runtime store root.
   */
  projectInputRoot?: string
  /** True when the project store is the plugin-managed Git checkout. */
  projectManaged?: boolean
  /** Scope a proposal receives when it does not name one. */
  defaultScope: Scope
  /** Configured location of the global store, resolved (whether or not it exists). */
  globalPath: string
  /** Absent when the global store is available. */
  globalProblem?: GlobalProblem
  /**
   * Set only when the project is a Git project but its managed store could not
   * be created or proven. The developer checkout is never substituted.
   */
  projectProblem?: ProjectStoreProblem
}

/** Expand a leading `~` (or `~/`); anything else is returned unchanged. */
export function expandHome(value: string, home: string = os.homedir()): string {
  if (value === "~") return home
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2))
  return value
}

/** Absolute path of the global store on this machine. */
export function globalStorePath(config: PluginConfig, home: string = os.homedir()): string {
  return path.resolve(expandHome(config.globalMemoryPath, home))
}

export type DirProbe = (root: string) => Promise<"dir" | "missing" | "other">

const defaultProbe: DirProbe = async (root) => {
  try {
    const stat = await fs.stat(root)
    return stat.isDirectory() ? "dir" : "other"
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing"
    throw err
  }
}

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
export async function resolveStores(
  projectDir: string,
  config: PluginConfig,
  opts: {
    home?: string
    probe?: DirProbe
    /** Internal test injection for the managed project store. */
    project?: ProjectStoreOptions
    /** Internal test injection for the global store refresh. */
    global?: GlobalStoreOptions
  } = {},
): Promise<StoreSet> {
  const resolved = await resolveProjectStore(projectDir, {
    ...(opts.home ? { home: opts.home } : {}),
    ...(opts.project ?? {}),
  })
  const project: Store = { scope: "project", root: resolved.root }
  const globalPath = globalStorePath(config, opts.home)

  const set: StoreSet = {
    project,
    projectInputRoot: resolved.repository ?? projectDir,
    defaultScope: "project",
    globalPath,
  }
  if (resolved.status === "managed" && resolved.managedRoot) {
    set.projectManaged = true
    project.access = { base: path.dirname(resolved.managedRoot), name: path.basename(resolved.managedRoot) }
  }
  if (resolved.status === "unavailable" && resolved.problem) set.projectProblem = resolved.problem

  if (!config.globalMemoryEnabled) {
    set.globalProblem = "disabled"
    return set
  }

  let kind: "dir" | "missing" | "other"
  try {
    kind = await (opts.probe ?? defaultProbe)(globalPath)
  } catch {
    set.globalProblem = "unreadable"
    return set
  }

  if (kind === "dir") {
    const globalResolved = await refreshGlobalStore(globalPath, {
      ...(opts.home ? { home: opts.home } : {}),
      ...(opts.project?.base ? { base: opts.project.base } : {}),
      ...(opts.project?.refreshIntervalMs !== undefined ? { refreshIntervalMs: opts.project.refreshIntervalMs } : {}),
      ...(opts.project?.forceRefresh !== undefined ? { forceRefresh: opts.project.forceRefresh } : {}),
      ...(opts.project?.git ? { git: opts.project.git } : {}),
      ...(opts.global ?? {}),
    })
    set.global = {
      scope: "global",
      root: globalPath,
      ...(globalResolved.access ? { access: globalResolved.access } : {}),
    }
    set.defaultScope = config.defaultScope
    return set
  }

  set.globalProblem = kind === "missing" ? "missing" : "not-directory"
  return set
}

/**
 * The project store, or `null` when the managed store could not be created or
 * proven. Callers must treat `null` as "unknown, unavailable" — never as an
 * empty store — and must not write through it.
 */
export function usableProjectStore(stores: StoreSet): Store | null {
  return stores.projectProblem ? null : stores.project
}

/** True when the project store may be read or written this session. */
export function projectStoreUsable(stores: StoreSet): boolean {
  return stores.projectProblem === undefined
}

/**
 * Stores that may be read or written, global first. An unavailable project
 * store is omitted, so no consumer can read it as empty or write into it.
 */
export function availableStores(stores: StoreSet): Store[] {
  const project = usableProjectStore(stores)
  const out: Store[] = []
  if (stores.global) out.push(stores.global)
  if (project) out.push(project)
  return out
}

/**
 * Run a complete filesystem operation against a store under its cross-process
 * access lease. Managed project stores serialize with refresh; the global store
 * and plain-directory project stores have no lease and simply run `fn`.
 *
 * A pending incomplete-refresh marker makes the consumer fail closed: the store
 * must be recovered by a resolve before anyone reads or writes it.
 */
export async function withStoreAccess<T>(store: Store, fn: () => Promise<T>): Promise<T> {
  const access = store.access
  if (!access) return fn()
  const label = store.scope === "global" ? "global" : "project"
  return withProjectStoreAccess(access, async () => {
    // Re-check the path under the lease: a cached Store must never follow a
    // symlink swapped in after resolution.
    const boundary = await assertAccessBoundary(access)
    if (!boundary.ok) {
      throw new StoreAccessError(
        `The ${label} memory store path is no longer valid (${boundary.detail}); nothing was read or written.`,
      )
    }
    if (!access.directRoot && (await pendingRefreshForAccess(access))) {
      throw new StoreAccessError(
        "The project memory store is recovering from an interrupted refresh. Try again in a moment.",
      )
    }
    return fn()
  })
}

/**
 * One line for the system prompt. Path-free, like the global notice: the model
 * only needs to know the project store is unavailable and that project writes
 * are disabled, not where the machine keeps it.
 */
export function projectProblemPrompt(problem: ProjectStoreProblem): string {
  switch (problem) {
    case "unavailable":
      return "Project memory is unavailable this session: its plugin-managed store could not be initialized. Project proposals are disabled until it is available; global memory still works."
    case "unproven":
      return "Project memory is unavailable this session: the plugin-managed store could not be verified as this repository's. Project proposals are disabled until it is available; global memory still works."
  }
}

/**
 * The same condition as an instruction a human can act on. Used by the memory
 * tools, where the concrete path is useful and the system prompt stays clean.
 */
export function projectProblemToolMessage(problem: ProjectStoreProblem, root: string): string {
  switch (problem) {
    case "unavailable":
      return `The project memory store is unavailable: its plugin-managed checkout at ${root} could not be initialized. Nothing was written. Check that the repository's remote is reachable, then retry; if the directory is stale, inspect or remove it yourself and retry.`
    case "unproven":
      return `The project memory store is unavailable: ${root} exists but its ownership could not be verified as this repository's. Nothing was written and nothing was modified. Inspect or remove that directory yourself, then retry.`
  }
}

/**
 * One line for the system prompt. Deliberately path-free: the prompt must not
 * carry machine paths, and the model only needs to know which store is in use.
 */
export function globalProblemPrompt(problem: GlobalProblem): string {
  switch (problem) {
    case "disabled":
      return "Global memory is disabled in this session's configuration; proposals go to the project store only."
    case "missing":
      return "Global memory is not configured this session; proposals go to the project store only."
    case "not-directory":
      return "Global memory is unusable this session (the configured path is not a folder); proposals go to the project store only."
    case "unreadable":
      return "Global memory is unreadable this session; proposals go to the project store only."
  }
}

/**
 * The same condition as an instruction a human can act on. Used by the memory
 * tools, where the concrete path is useful and nothing is injected into the
 * prompt.
 */
export function globalProblemToolMessage(problem: GlobalProblem, globalPath: string): string {
  switch (problem) {
    case "disabled":
      return "The global memory store is disabled by configuration. Set globalMemoryEnabled to true, or propose with scope \"project\"."
    case "missing":
      return `The global memory store is not configured: nothing exists at ${globalPath}. Clone the private memory repository to that path (or point globalMemoryPath at your clone), then retry. Propose with scope "project" to use the project store instead.`
    case "not-directory":
      return `The global memory store is unusable: ${globalPath} is not a folder. Point globalMemoryPath at your clone of the private memory repository. Propose with scope "project" to use the project store instead.`
    case "unreadable":
      return `The global memory store is unreadable: ${globalPath} could not be inspected. Check its permissions. Propose with scope "project" to use the project store instead.`
  }
}
