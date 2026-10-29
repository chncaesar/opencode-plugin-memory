import type { MemoryEntry, MemoryStore, PluginConfig } from "./types.js"
import type { Logger } from "./logging.js"
import { readStore } from "./storage.js"
import {
  RELATIONS,
  activeEntries,
  clip,
  findingKey,
  hashActive,
  hashEntries,
  pruneState,
  readReviewState,
  writeReviewState,
  type Finding,
  type Relation,
} from "./review.js"
import { AUDIT_AGENT_NAME } from "./auditAgent.js"

/**
 * Background semantic audit.
 *
 * After a session goes idle, and only if the set of active memories changed
 * since the last audit and enough time has passed, a model is asked whether any
 * memories duplicate, refine or contradict each other. Findings go to
 * review.json and reach the main LLM through a one-line system-prompt hint and
 * the memory_review tool. The audit never edits MEMORY.md.
 */

// ─── Prompt and response handling ────────────────────────────────────────────

const MAX_ACTIVE_ENTRIES = 200

export const AUDIT_SYSTEM_PROMPT = [
  "You audit a list of project memory entries for maintenance problems.",
  "Report only pairs or groups of entries that: duplicate each other (say the same thing),",
  "refine each other (one is a more specific or more general version of the other),",
  "or contradict each other (cannot both be followed).",
  "Entries about different topics are NOT findings. Entries on the same topic that are compatible are NOT findings.",
  "Do not call any tools. Reply with a single JSON object and nothing else, in this shape:",
  '{"findings":[{"ids":["MEM-001","MEM-004"],"relation":"duplicate|refinement|contradiction","reason":"one short sentence in the entries\' language"}]}',
  'If there are no problems reply {"findings":[]}.',
].join("\n")

export function buildAuditPrompt(entries: MemoryEntry[]): string {
  const blocks = entries.map((e) => {
    const tags = e.tags && e.tags.length > 0 ? ` tags: ${e.tags.join(", ")}` : ""
    return `[${e.id}] ${e.title}${tags}\n${e.content}`
  })
  return `Memory entries:\n\n${blocks.join("\n\n---\n\n")}`
}

/** Pull the first balanced {...} object out of a model reply (tolerates prose and code fences). */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{")
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * Turn a model reply into validated findings. Anything malformed or referring
 * to unknown/archived IDs is dropped. Returns null when the reply is not a
 * usable audit result at all (so the caller can treat it as a failed run).
 */
export function parseAuditResponse(text: string, store: MemoryStore): Finding[] | null {
  const obj = extractJsonObject(text)
  if (!obj || typeof obj !== "object") return null
  const list = (obj as Record<string, unknown>)["findings"]
  if (!Array.isArray(list)) return null

  const active = new Map(activeEntries(store).map((e) => [e.id, e]))
  const seen = new Set<string>()
  const out: Finding[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    const ids = Array.isArray(r["ids"]) ? [...new Set(r["ids"].filter((i): i is string => typeof i === "string"))] : []
    const relation = r["relation"]
    if (ids.length < 2 || !ids.every((i) => active.has(i))) continue
    if (typeof relation !== "string" || !(RELATIONS as readonly string[]).includes(relation)) continue
    const sorted = ids.sort()
    const key = findingKey(sorted)
    if (seen.has(key)) continue
    seen.add(key)
    const reason = typeof r["reason"] === "string" ? r["reason"].replace(/\s+/g, " ").trim() : ""
    out.push({
      ids: sorted,
      relation: relation as Relation,
      reason: clip(reason, 240),
      hash: hashEntries(sorted.map((i) => active.get(i)!)),
    })
  }
  return out
}

// ─── One audit run ───────────────────────────────────────────────────────────

/** Sends system + user text to a model and returns the reply text. Throws on failure. */
export type ModelCall = (system: string, prompt: string) => Promise<string>

export type AuditOutcome =
  | "disabled"
  | "skipped-unchanged"
  | "skipped-interval"
  | "skipped-too-few"
  | "skipped-too-many"
  | "discarded-changed"
  | "failed"
  | "done"

export type AuditDeps = {
  directory: string
  config: PluginConfig
  logger: Logger
  call: ModelCall
  now?: () => Date
  /** Bypass the minimum interval (explicit refresh). Unchanged entries are still skipped. */
  force?: boolean
}

/**
 * Run one audit if the guards allow it. Never throws. Guards, in order:
 * enabled, at least two active entries, not too many entries, entries changed
 * since the last completed audit, minimum interval since the last attempt.
 */
export async function runAudit(deps: AuditDeps): Promise<AuditOutcome> {
  const { directory, config, logger, call } = deps
  const now = deps.now ?? (() => new Date())
  if (!config.backgroundAudit) return "disabled"

  try {
    const store = await readStore(directory)
    const active = activeEntries(store)
    const state = await readReviewState(directory)
    const hash = hashActive(store)

    if (active.length < 2) {
      if (state.findings.length > 0 || state.lastHash !== hash) {
        await writeReviewState(directory, { ...state, findings: [], lastHash: hash })
      }
      return "skipped-too-few"
    }
    if (active.length > MAX_ACTIVE_ENTRIES) {
      await logger.info("audit", `skipped: ${active.length} active entries exceeds ${MAX_ACTIVE_ENTRIES}`)
      return "skipped-too-many"
    }
    if (hash === state.lastHash) return "skipped-unchanged"

    if (!deps.force) {
      const last = Date.parse(state.lastAuditAt)
      if (!Number.isNaN(last) && now().getTime() - last < config.auditIntervalMinutes * 60_000) {
        return "skipped-interval"
      }
    }

    let reply: string
    try {
      reply = await call(AUDIT_SYSTEM_PROMPT, buildAuditPrompt(active))
    } catch (err) {
      await markAttempt(directory, now())
      await logger.error("audit", err)
      return "failed"
    }

    const findings = parseAuditResponse(reply, store)
    if (findings === null) {
      await markAttempt(directory, now())
      await logger.error("audit", "unparsable audit reply: " + clip(reply, 200))
      return "failed"
    }

    // If memories changed while the model was working, the verdict may describe
    // text that no longer exists. Keep lastHash as is so the next idle re-audits.
    const fresh = await readStore(directory)
    if (hashActive(fresh) !== hash) {
      await markAttempt(directory, now())
      await logger.info("audit", "discarded: memories changed during audit")
      return "discarded-changed"
    }

    const latest = await readReviewState(directory)
    await writeReviewState(
      directory,
      pruneState(fresh, { ...latest, findings, lastHash: hash, lastAuditAt: now().toISOString() }),
    )
    await logger.info("audit", `${findings.length} finding(s) over ${active.length} entries`)
    return "done"
  } catch (err) {
    await logger.error("audit", err)
    return "failed"
  }
}

async function markAttempt(directory: string, at: Date): Promise<void> {
  const state = await readReviewState(directory)
  await writeReviewState(directory, { ...state, lastAuditAt: at.toISOString() })
}

// ─── SDK-backed model call ───────────────────────────────────────────────────

/** The slice of the OpenCode SDK client the audit uses. */
export type AuditClient = {
  session: {
    create(options: { body?: { title?: string }; query?: { directory?: string } }): Promise<{ data?: { id: string } | undefined; error?: unknown }>
    prompt(options: {
      path: { id: string }
      query?: { directory?: string }
      body: {
        agent?: string
        system?: string
        parts: Array<{ type: "text"; text: string }>
      }
    }): Promise<{
      data?: {
        info?: { error?: { name?: string; data?: { message?: string } } }
        parts: Array<{ type: string; text?: string }>
      } | undefined
      error?: unknown
    }>
    delete(options: { path: { id: string }; query?: { directory?: string } }): Promise<unknown>
  }
}

const AUDIT_TIMEOUT_MS = 300_000

/**
 * Build a ModelCall that runs in a throwaway session under the restricted audit
 * agent. The session is registered in `auditSessions` (so event and
 * system-prompt hooks ignore it) and always deleted afterwards.
 */
export function createSdkModelCall(
  client: AuditClient,
  directory: string,
  auditSessions: Set<string>,
  agentName: string = AUDIT_AGENT_NAME,
): ModelCall {
  return async (system, prompt) => {
    const query = { directory }
    const created = await client.session.create({ body: { title: "[memory-audit]" }, query })
    const id = created.data?.id
    if (!id) throw new Error("audit: could not create session")
    auditSessions.add(id)
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("audit: model call timed out")), AUDIT_TIMEOUT_MS)
      })
      try {
        const res = await Promise.race([
          client.session.prompt({
            path: { id },
            query,
            body: { agent: agentName, system, parts: [{ type: "text", text: prompt }] },
          }),
          timeout,
        ])
        if (res.error || !res.data) throw new Error("audit: model call failed")
        // Provider failures come back as a normal assistant message carrying
        // info.error and no text parts; surface the provider's reason.
        const providerError = res.data.info?.error
        if (providerError) {
          const detail = providerError.data?.message ?? providerError.name ?? "unknown provider error"
          throw new Error(`audit: model call failed: ${detail}`)
        }
        return res.data.parts
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("\n")
      } finally {
        if (timer) clearTimeout(timer)
      }
    } finally {
      await client.session.delete({ path: { id }, query }).catch(() => undefined)
      // Keep the id registered briefly: late idle/deleted events may still arrive.
      setTimeout(() => auditSessions.delete(id), 60_000).unref?.()
    }
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export type AuditScheduler = {
  /** Call when any session goes idle. Fire-and-forget; safe to call often. */
  onSessionIdle(sessionID: string): void
  /** Run an audit now, bypassing the interval. Waits for an in-flight audit first. */
  runNow(): Promise<AuditOutcome>
  /** Resolves when no audit is running (for tests). */
  settled(): Promise<void>
}

/** Serializes audits in this process and ignores idle events from audit sessions. */
export function createAuditScheduler(deps: AuditDeps, auditSessions: Set<string>): AuditScheduler {
  let current: Promise<AuditOutcome> | null = null

  const start = (force: boolean): Promise<AuditOutcome> => {
    let p: Promise<AuditOutcome>
    p = runAudit({ ...deps, force }).finally(() => {
      if (current === p) current = null
    })
    current = p
    return p
  }

  return {
    onSessionIdle(sessionID) {
      if (!deps.config.backgroundAudit) return
      if (auditSessions.has(sessionID)) return
      if (current) return
      void start(false)
    },
    async runNow() {
      while (current) await current.catch(() => undefined)
      return start(true)
    },
    async settled() {
      while (current) await current.catch(() => undefined)
    },
  }
}
