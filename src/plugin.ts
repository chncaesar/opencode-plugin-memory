import type { Config, Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { DEFAULT_CONFIG, type AuditProvider, type PluginConfig, type Scope } from "./types.js"
import { createMemoryTools } from "./tools.js"
import { buildSystemPrompt, loadPromptBlock } from "./summary.js"
import { listStagedProposals } from "./storage.js"
import { availableStores, resolveStores } from "./stores.js"
import { createLogger, type Logger } from "./logging.js"
import { migrateLegacyStores } from "./migrate.js"
import {
  auditWarning,
  createAuditScheduler,
  createHttpModelCall,
  createSdkModelCall,
  type AuditClient,
  type ModelCall,
} from "./audit.js"
import { registerAuditAgent } from "./auditAgent.js"
import { tool } from "@opencode-ai/plugin/tool"

/**
 * Parse and validate plugin options from opencode.json.
 * All options are optional; missing values fall back to DEFAULT_CONFIG.
 *
 * Example opencode.json entry (OpenCode 2.x):
 *   "plugins": [{ "package": "@chncaesar/opencode-plugin-memory", "options": { "maxSummaryChars": 10000 } }]
 */
export function resolveConfig(options?: PluginOptions): PluginConfig {
  if (!options || typeof options !== "object") return DEFAULT_CONFIG
  const raw = options as Record<string, unknown>

  const config: PluginConfig = {
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
    auditBatchChars:
      typeof raw["auditBatchChars"] === "number" && raw["auditBatchChars"] > 0
        ? raw["auditBatchChars"]
        : DEFAULT_CONFIG.auditBatchChars,
    globalMemoryEnabled:
      typeof raw["globalMemoryEnabled"] === "boolean"
        ? raw["globalMemoryEnabled"]
        : DEFAULT_CONFIG.globalMemoryEnabled,
    globalMemoryPath:
      typeof raw["globalMemoryPath"] === "string" && raw["globalMemoryPath"].trim().length > 0
        ? raw["globalMemoryPath"].trim()
        : DEFAULT_CONFIG.globalMemoryPath,
    defaultScope:
      raw["defaultScope"] === "project" || raw["defaultScope"] === "global"
        ? raw["defaultScope"]
        : DEFAULT_CONFIG.defaultScope,
    globalIndexShare:
      typeof raw["globalIndexShare"] === "number" && raw["globalIndexShare"] > 0 && raw["globalIndexShare"] < 1
        ? raw["globalIndexShare"]
        : DEFAULT_CONFIG.globalIndexShare,
  }

  const audit = parseAuditProvider(raw["auditProvider"])
  if (audit.provider) config.auditProvider = audit.provider
  if (audit.error) config.auditProviderError = audit.error
  return config
}

/**
 * Validate the `auditProvider` option. A provider that is present but incomplete
 * yields an error rather than being dropped: silently falling back to the host's
 * credential would look like the option worked.
 */
export function parseAuditProvider(raw: unknown): { provider?: AuditProvider; error?: string } {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== "object") {
    return { error: '"auditProvider" must be an object with baseUrl, apiKey and model' }
  }
  const o = raw as Record<string, unknown>
  const text = (key: string): string =>
    typeof o[key] === "string" ? (o[key] as string).trim() : ""

  const baseUrl = text("baseUrl")
  const apiKey = text("apiKey")
  const model = text("model")
  const missing = [baseUrl ? "" : "baseUrl", apiKey ? "" : "apiKey", model ? "" : "model"].filter(Boolean)
  if (missing.length > 0) {
    return { error: `"auditProvider" is missing ${missing.join(", ")}` }
  }

  const provider: AuditProvider = { baseUrl, apiKey, model }
  const rawHeaders = o["headers"]
  if (rawHeaders && typeof rawHeaders === "object") {
    const entries = Object.entries(rawHeaders as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    )
    if (entries.length > 0) provider.headers = Object.fromEntries(entries)
  }
  return { provider }
}

/**
 * Pick the model call the audit will use: a direct provider call when one is
 * configured, a clear failure when the configuration is unusable, otherwise the
 * host-mediated call.
 */
export function resolveAuditCall(config: PluginConfig, hostCall: ModelCall): ModelCall {
  if (config.auditProvider) return createHttpModelCall(config.auditProvider)
  if (config.auditProviderError) {
    return async () => {
      throw new Error(`audit: ${config.auditProviderError}`)
    }
  }
  return hostCall
}

/**
 * Build the block injected into every system prompt: the index derived from
 * `memory/active/` (titles and ids only, never full bodies) plus the writing
 * policy. Nothing is written to disk: running OpenCode in a directory must not
 * create or modify a `memory/` folder there.
 *
 * This runs inside the system-prompt hook, so it must never throw: an unreadable
 * memory store is a diagnostic, not a reason to break a normal conversation. A
 * store that cannot be read degrades to the policy alone, and the filesystem
 * detail goes to the machine-local log, never into the prompt.
 */
async function injectMemoryBlock(directory: string, config: PluginConfig, logger: Logger): Promise<string> {
  try {
    const stores = await resolveStores(directory, config)
    const block = await loadPromptBlock(
      stores,
      config.maxSummaryChars,
      config.globalIndexShare,
      async (problems) => {
        for (const problem of problems) await logger.error("index", `${problem.code} ${problem.file}`)
      },
    )
    const notices: string[] = [block]
    for (const store of availableStores(stores)) {
      const warning = await auditWarning(store.root, config).catch(() => null)
      if (warning) notices.push(warning)
      const pending = await pendingPublishNotice(store.root, store.scope).catch(() => null)
      if (pending) notices.push(pending)
    }
    return notices.join("\n\n")
  } catch (err) {
    await logger.error("system-prompt", err)
    return buildSystemPrompt(
      {
        project: { scope: "project", memories: [], omitted: 0, unavailable: true },
        globalNotice: "Global memory is unavailable this session.",
      },
      config.maxSummaryChars,
      config.globalIndexShare,
    )
  }
}

/**
 * Tell the model when staged proposals have no pull request yet. The background
 * audit stages retire proposals while no model is in the loop, so without this
 * nothing would ever prompt a `memory_publish` call. Same rule as for
 * memory_propose/update/delete: the model publishes, the human merges.
 *
 * Each store is reported separately: a global proposal opens its PR in the
 * memory repository, a project proposal in the current one.
 */
export async function pendingPublishNotice(directory: string, scope: Scope = "project"): Promise<string | null> {
  const staged = await listStagedProposals(directory)
  if (staged.length === 0) return null
  const lines = staged.slice(0, 10).map((m) => `- [${m.id}] ${m.title} (${m.intent === "retire" ? "retire" : "propose"})`)
  const more = staged.length > lines.length ? `\n… and ${staged.length - lines.length} more` : ""
  const where = scope === "global" ? "the global store" : "the project store"
  return [
    `[memory plugin] ${staged.length} staged memory proposal${staged.length === 1 ? " has" : "s have"} no pull request yet in ${where}:`,
    lines.join("\n") + more,
    "Call memory_publish to open the pull requests (the human merge is the approval gate; no confirmation is needed).",
  ].join("\n")
}

/**
 * opencode-plugin-memory — PR-gated project memory.
 *
 * The agent only PROPOSES memories by writing files into `.memory/staging/`. A
 * bot (see bot.ts) turns those into pull requests; a human merges them; merged
 * memories live under `memory/active/`. Their titles are indexed on every
 * session start; full bodies load lazily through `memory_read`.
 *
 * A background semantic audit runs after sessions go idle and asks a model to
 * flag duplicate / refining / contradicting memories; each finding becomes a
 * retirement proposal, which the bot turns into a PR.
 *
 * Layout:
 *   .memory/staging/   machine-local proposals (git-ignored)
 *   memory/active/     merged truth
 *   memory/retired/    retired memories
 */
export const server: Plugin = async (input: PluginInput, options?: PluginOptions): Promise<Hooks> => {
  const config = resolveConfig(options)
  const directory = input.directory
  const logger = createLogger(directory, config.enableLog)

  // One-time migration of the legacy single-file store into the per-file model.
  try {
    await migrateLegacyStores(directory, logger)
  } catch (err) {
    await logger.error("migration", err)
  }

  // Throwaway sessions created by the background audit. Hooks ignore them so
  // the audit neither injects memory into itself nor triggers further audits.
  const auditSessions = new Set<string>()
  const notify = async (message: string): Promise<void> => {
    const tui = (input.client as unknown as { tui?: { showToast?: (o: unknown) => Promise<unknown> } }).tui
    await tui?.showToast?.({ body: { message, variant: "warning" } })
  }
  // One scheduler per store root, created lazily: a global store cloned after
  // the session started is picked up without a restart. The audit itself reads
  // only its own store, so the two never see each other's context.
  const sdkCall = resolveAuditCall(
    config,
    createSdkModelCall(input.client as unknown as AuditClient, directory, auditSessions),
  )
  const schedulers = new Map<string, ReturnType<typeof createAuditScheduler>>()
  const schedulerFor = (root: string): ReturnType<typeof createAuditScheduler> => {
    let scheduler = schedulers.get(root)
    if (!scheduler) {
      scheduler = createAuditScheduler({ directory: root, config, notify, logger, call: sdkCall }, auditSessions)
      schedulers.set(root, scheduler)
    }
    return scheduler
  }
  const memoryTools = createMemoryTools(config, logger)

  const hooks: Hooks = {
    // ── Register the restricted audit agent ───────────────────────────────
    config: async (cfg: Config) => {
      // A configured auditProvider calls the model directly; no agent is needed.
      if (!config.backgroundAudit || config.auditProvider) return
      registerAuditAgent(cfg as unknown as { agent?: Record<string, unknown>; small_model?: string })
    },

    // ── Register the six memory tools ────────────────────────────────────
    tool: {
      memory_propose: memoryTools.memory_propose,
      memory_update: memoryTools.memory_update,
      memory_delete: memoryTools.memory_delete,
      memory_read: memoryTools.memory_read,
      memory_review: memoryTools.memory_review,
      memory_publish: memoryTools.memory_publish,
    },

    // ── Background audit: run after a session goes idle, once per store ────
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const stores = await resolveStores(directory, config)
      for (const store of availableStores(stores)) {
        schedulerFor(store.root).onSessionIdle(event.properties.sessionID)
      }
    },

    // ── Inject the committed memory index into every system prompt ─────────
    "experimental.chat.system.transform": async (hookInput, output) => {
      if (hookInput.sessionID && auditSessions.has(hookInput.sessionID)) return
      output.system.push(await injectMemoryBlock(directory, config, logger))
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
  experimental: { generate: { text: V2GenerateText } }
}

/** `ctx.experimental.generate.text`: plugin-context methods take `requestOptions` (an AbortSignal) as the last argument. */
export type V2GenerateText = (
  input: { prompt: string; model?: { providerID: string; id: string } },
  requestOptions?: { signal?: AbortSignal },
) => Promise<{ text: string }>

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
 * Model call for the V2 audit, with a timeout.
 *
 * A timeout rejects the call and signals abort through the AbortSignal passed as
 * `requestOptions`. OpenCode 2.2.7 does NOT honour that signal for
 * `experimental.generate.text` (packages/plugin/src/promise/adapter.ts drops the
 * second argument), so the host request keeps running after a timeout. What
 * actually prevents a pile-up is the guard below: while the previous request is
 * still unsettled, the next call fails fast instead of starting a second
 * concurrent request. The signal is still passed so a host that does honour it
 * cancels the request.
 */
export function createV2ModelCall(
  generate: V2GenerateText,
  model?: { providerID: string; id: string },
  timeoutMs: number = V2_AUDIT_TIMEOUT_MS,
): ModelCall {
  let inFlight: Promise<void> | null = null
  return async (system, prompt) => {
    if (inFlight) throw new Error("audit: the previous model call is still running; not starting another")

    const controller = new AbortController()
    const started = generate({ prompt: `${system}\n\n${prompt}`, ...(model ? { model } : {}) }, { signal: controller.signal })
    const settled: Promise<void> = started.then(
      () => undefined,
      () => undefined,
    )
    inFlight = settled
    void settled.then(() => {
      if (inFlight === settled) inFlight = null
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Reject first, then abort: a host that honours the signal fails the request at once, and the caller must see the timeout, not "aborted".
        reject(new Error(`audit: model call timed out after ${Math.round(timeoutMs / 1000)}s`))
        controller.abort()
      }, timeoutMs)
    })
    try {
      return (await Promise.race([started, timeout])).text
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
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

  try {
    await migrateLegacyStores(directory, logger)
  } catch (err) {
    await logger.error("migration", err)
  }

  // Read ctx.experimental lazily: a host without it must not stop the plugin from loading.
  const hostCall = createV2ModelCall((input, opts) => ctx.experimental.generate.text(input, opts), auditModel)
  const call = resolveAuditCall(config, hostCall)

  // One scheduler per store root, created lazily so a global store cloned later
  // is audited without a restart.
  const auditSessions = new Set<string>()
  const schedulers = new Map<string, ReturnType<typeof createAuditScheduler>>()
  const schedulerFor = (root: string): ReturnType<typeof createAuditScheduler> => {
    let scheduler = schedulers.get(root)
    if (!scheduler) {
      scheduler = createAuditScheduler({ directory: root, config, logger, call }, auditSessions)
      schedulers.set(root, scheduler)
    }
    return scheduler
  }
  const memoryTools = createMemoryTools(config, logger)

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
      event.system.push({ type: "text", text: await injectMemoryBlock(directory, config, logger) })
    }),
  )

  if (config.backgroundAudit) {
    registrations.push(
      await ctx.session.hook("experimental.idle", async (event: { sessionID: string }) => {
        const stores = await resolveStores(directory, config)
        for (const store of availableStores(stores)) {
          schedulerFor(store.root).onSessionIdle(event.sessionID)
        }
      }),
    )
  }

  return async () => {
    await Promise.all(registrations.map((r) => r.dispose()))
  }
}
