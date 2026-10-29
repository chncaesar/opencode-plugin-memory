import type { Config, Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { DEFAULT_CONFIG, type PluginConfig } from "./types.js"
import { createMemoryTools } from "./tools.js"
import { buildSystemPrompt } from "./summary.js"
import { readStore } from "./storage.js"
import { createLogger } from "./logging.js"
import { collectAttention, nudgeLine, readReviewState } from "./review.js"
import { createAuditScheduler, createSdkModelCall, type AuditClient } from "./audit.js"
import { registerAuditAgent } from "./auditAgent.js"

/**
 * Parse and validate plugin options from opencode.json.
 * All options are optional; missing values fall back to DEFAULT_CONFIG.
 *
 * Example opencode.json entry:
 *   "plugin": [["opencode-plugin-memory", { "maxSummaryChars": 3000 }]]
 */
function resolveConfig(options?: PluginOptions): PluginConfig {
  if (!options || typeof options !== "object") return DEFAULT_CONFIG
  const raw = options as Record<string, unknown>

  return {
    maxSummaryChars:
      typeof raw["maxSummaryChars"] === "number" && raw["maxSummaryChars"] > 0
        ? raw["maxSummaryChars"]
        : DEFAULT_CONFIG.maxSummaryChars,
    enableLog:
      typeof raw["enableLog"] === "boolean"
        ? raw["enableLog"]
        : DEFAULT_CONFIG.enableLog,
    staleDays:
      typeof raw["staleDays"] === "number" && raw["staleDays"] > 0
        ? raw["staleDays"]
        : DEFAULT_CONFIG.staleDays,
    backgroundAudit:
      typeof raw["backgroundAudit"] === "boolean"
        ? raw["backgroundAudit"]
        : DEFAULT_CONFIG.backgroundAudit,
    auditIntervalMinutes:
      typeof raw["auditIntervalMinutes"] === "number" && raw["auditIntervalMinutes"] > 0
        ? raw["auditIntervalMinutes"]
        : DEFAULT_CONFIG.auditIntervalMinutes,
  }
}

/**
 * opencode-plugin-memory — project-scoped persistent memory
 *
 * Provides five tools (memory_add, memory_update, memory_delete, memory_read,
 * memory_review) and injects a compact memory summary into every system prompt
 * so the LLM always knows what has been remembered without needing to read the
 * full file.
 *
 * A background audit runs after sessions go idle and records possible memory
 * conflicts in review.json; it never edits MEMORY.md.
 *
 * Storage: <projectDir>/.opencode/memory/MEMORY.md
 * Summary: <projectDir>/.opencode/memory/memory_summary.md
 * Review:  <projectDir>/.opencode/memory/review.json
 */
export const server: Plugin = async (input: PluginInput, options?: PluginOptions): Promise<Hooks> => {
  const config = resolveConfig(options)
  const directory = input.directory
  const logger = createLogger(directory, config.enableLog)

  // Throwaway sessions created by the background audit. Hooks ignore them so
  // the audit neither injects memory into itself nor triggers further audits.
  const auditSessions = new Set<string>()
  const scheduler = createAuditScheduler(
    {
      directory,
      config,
      logger,
      call: createSdkModelCall(input.client as unknown as AuditClient, directory, auditSessions),
    },
    auditSessions,
  )
  const memoryTools = createMemoryTools(config, logger, { runAuditNow: () => scheduler.runNow() })

  const hooks: Hooks = {
    // ── Register the restricted audit agent ───────────────────────────────
    config: async (cfg: Config) => {
      if (!config.backgroundAudit) return
      registerAuditAgent(cfg as unknown as { agent?: Record<string, unknown>; small_model?: string })
    },

    // ── Register the five memory tools ────────────────────────────────────
    tool: {
      memory_add: memoryTools.memory_add,
      memory_update: memoryTools.memory_update,
      memory_delete: memoryTools.memory_delete,
      memory_read: memoryTools.memory_read,
      memory_review: memoryTools.memory_review,
    },

    // ── Background audit: run after a session goes idle ───────────────────
    event: async ({ event }) => {
      if (event.type === "session.idle") scheduler.onSessionIdle(event.properties.sessionID)
    },

    // ── Inject memory block into every system prompt ──────────────────────
    "experimental.chat.system.transform": async (hookInput, output) => {
      if (hookInput.sessionID && auditSessions.has(hookInput.sessionID)) return
      const store = await readStore(directory)
      const nudge = nudgeLine(collectAttention(store, await readReviewState(directory)))
      output.system.push(buildSystemPrompt(store, config.maxSummaryChars, nudge))
    },
  }

  return hooks
}

// Default export for compatibility with opencode's plugin loader
export default server
