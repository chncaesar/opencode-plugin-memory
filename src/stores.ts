import fs from "fs/promises"
import os from "os"
import path from "path"
import type { PluginConfig, Scope } from "./types.js"

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
}

/** Why the global store is not usable this session. */
export type GlobalProblem = "disabled" | "missing" | "not-directory" | "unreadable"

export type StoreSet = {
  /** Present only when the global store is readable. */
  global?: Store
  /** Always present: the session directory is the project store root. */
  project: Store
  /** Scope a proposal receives when it does not name one. */
  defaultScope: Scope
  /** Configured location of the global store, resolved (whether or not it exists). */
  globalPath: string
  /** Absent when the global store is available. */
  globalProblem?: GlobalProblem
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
 * The project store is always available (it may be empty). The global store is
 * used only when enabled and its folder exists: a missing clone, a path that is
 * a file, or an unreadable folder degrades to project-only memory, never to a
 * broken session. Probes are injectable so tests never touch the real store.
 */
export async function resolveStores(
  projectDir: string,
  config: PluginConfig,
  opts: { home?: string; probe?: DirProbe } = {},
): Promise<StoreSet> {
  const project: Store = { scope: "project", root: projectDir }
  const globalPath = globalStorePath(config, opts.home)

  if (!config.globalMemoryEnabled) {
    return { project, defaultScope: "project", globalPath, globalProblem: "disabled" }
  }

  let kind: "dir" | "missing" | "other"
  try {
    kind = await (opts.probe ?? defaultProbe)(globalPath)
  } catch {
    return { project, defaultScope: "project", globalPath, globalProblem: "unreadable" }
  }

  if (kind === "dir") {
    return { global: { scope: "global", root: globalPath }, project, defaultScope: config.defaultScope, globalPath }
  }
  return {
    project,
    defaultScope: "project",
    globalPath,
    globalProblem: kind === "missing" ? "missing" : "not-directory",
  }
}

/** Stores that may be read or written, global first. */
export function availableStores(stores: StoreSet): Store[] {
  return stores.global ? [stores.global, stores.project] : [stores.project]
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
