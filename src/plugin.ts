import type { Config, Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { DEFAULT_CONFIG, type PluginConfig } from "./types.js"
import { createMemoryTools } from "./tools.js"
import { buildSystemPrompt } from "./summary.js"
import { migrateLegacyStore, readStore, validStoreDir } from "./storage.js"
import { createLogger } from "./logging.js"
import { collectAttention, nudgeLine, readReviewState } from "./review.js"
import { createAuditScheduler, createSdkModelCall, type AuditClient } from "./audit.js"
import { registerAuditAgent } from "./auditAgent.js"
import { tool } from "@opencode-ai/plugin/tool"
import type { ModelCall } from "./audit.js"

/**
 * Parse and validate plugin options from opencode.json.
 * All options are optional; missing values fall back to DEFAULT_CONFIG.
 *
 * Example opencode.json entry:
 *   "plugin": [["opencode-plugin-memory", { "maxSummaryChars": 3000 }]]
 */
export function resolveConfig(options?: PluginOptions): PluginConfig {
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
    storeDir: validStoreDir(raw["storeDir"]) ?? DEFAULT_CONFIG.storeDir,
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
 * Storage: <projectDir>/.agents/memory/MEMORY.md (committable; `storeDir` overrides)
 * Summary: <projectDir>/.opencode/memory/memory_summary.md (machine-local)
 * Review:  <projectDir>/.opencode/memory/review.json (machine-local)
 */
export const server: Plugin = async (input: PluginInput, options?: PluginOptions): Promise<Hooks> => {
  const config = resolveConfig(options)
  const directory = input.directory
  const logger = createLogger(directory, config.enableLog)

  // One-time migration of a legacy `.opencode/memory/MEMORY.md` into the new
  // shared store location. Failure is logged, never fatal.
  try {
    await migrateLegacyStore(directory, config.storeDir)
  } catch (err) {
    await logger.error("migration", err)
  }

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
      const store = await readStore(directory, config.storeDir)
      const nudge = nudgeLine(collectAttention(store, await readReviewState(directory)))
      output.system.push(buildSystemPrompt(store, config.maxSummaryChars, nudge))
    },
  }

  return hooks
}

// ─── V2 host (OpenCode >= 2.x) ───────────────────────────────────────────────

/** Minimal structural view of the V2 plugin context; only what this plugin uses. */
type Registration = { dispose: () => Promise<void> }
export type V2Context = {
  location: { directory: string }
  options?: Record<string, unknown>
  tool: { transform: (fn: (editor: { add: (t: unknown) => void }) => void) => Promise<Registration> }
  session: {
    hook: (
      name: "context" | "experimental.idle",
      cb: (input: any) => Promise<void> | void,
    ) => Promise<Registration>
  }
  experimental: { generate: { text: (input: { prompt: string; model?: { providerID: string; id: string } }) => Promise<{ text: string }> } }
}

const V2_AUDIT_TIMEOUT_MS = 300_000

/**
 * Parse the optional `auditModel` plugin option ("providerID/modelID") into a
 * V2 model ref. Without it the host picks a default model, which may be one
 * the user cannot call (e.g. region-blocked).
 */
export function parseAuditModel(raw: unknown): { providerID: string; id: string } | undefined {
  if (typeof raw !== "string") return undefined
  const slash = raw.indexOf("/")
  if (slash <= 0 || slash === raw.length - 1) return undefined
  return { providerID: raw.slice(0, slash), id: raw.slice(slash + 1) }
}

/**
 * V2 entry point. The audit uses stateless `generate.text`, so there is no
 * throwaway session and no audit agent to register or to ignore in hooks.
 * `generate.text` takes no system prompt, so system and user text are joined.
 * It uses the `auditModel` option ("providerID/modelID") when set, otherwise the
 * host's default model (the V1 audit agent preferred `small_model`).
 */
export async function setup(ctx: V2Context): Promise<() => Promise<void>> {
  const config = resolveConfig(ctx.options)
  const auditModel = parseAuditModel(ctx.options?.["auditModel"])
  const directory = ctx.location.directory
  const logger = createLogger(directory, config.enableLog)

  // One-time migration of a legacy `.opencode/memory/MEMORY.md` into the new
  // shared store location. Failure is logged, never fatal.
  try {
    await migrateLegacyStore(directory, config.storeDir)
  } catch (err) {
    await logger.error("migration", err)
  }

  const call: ModelCall = async (system, prompt) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("audit: model call timed out")), V2_AUDIT_TIMEOUT_MS)
    })
    try {
      const res = await Promise.race([ctx.experimental.generate.text({ prompt: `${system}\n\n${prompt}`, ...(auditModel ? { model: auditModel } : {}) }), timeout])
      return res.text
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const scheduler = createAuditScheduler({ directory, config, logger, call }, new Set<string>())
  const memoryTools = createMemoryTools(config, logger, { runAuditNow: () => scheduler.runNow() })

  const registrations: Registration[] = []
  registrations.push(
    await ctx.tool.transform((editor) => {
      for (const [name, def] of Object.entries(memoryTools)) {
        editor.add({
          name,
          description: def.description,
          input: tool.schema.object(def.args),
          options: { codemode: false },
          execute: async (args: unknown) => {
            const res = await def.execute(args as never, { directory } as never)
            if (typeof res === "string") return { content: res }
            const r = res as { output: string; metadata?: Record<string, unknown>; title?: string }
            return { content: r.output, metadata: { ...(r.title ? { title: r.title } : {}), ...r.metadata } }
          },
        })
      }
    }),
  )

  registrations.push(
    await ctx.session.hook("context", async (event: { system: Array<{ type: "text"; text: string }> }) => {
      const store = await readStore(directory, config.storeDir)
      const nudge = nudgeLine(collectAttention(store, await readReviewState(directory)))
      event.system.push({ type: "text", text: buildSystemPrompt(store, config.maxSummaryChars, nudge) })
    }),
  )

  if (config.backgroundAudit) {
    registrations.push(
      await ctx.session.hook("experimental.idle", (event: { sessionID: string }) => {
        scheduler.onSessionIdle(event.sessionID)
      }),
    )
  }

  return async () => {
    await Promise.all(registrations.map((r) => r.dispose()))
  }
}
