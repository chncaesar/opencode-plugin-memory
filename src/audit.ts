import crypto from "crypto"
import fs from "fs/promises"
import path from "path"
import type { Memory, PluginConfig, RetiredReason } from "./types.js"
import type { Logger } from "./logging.js"
import { listActiveMemories, listStagedProposals, machineDir, writeProposal } from "./storage.js"
import { AUDIT_AGENT_NAME } from "./auditAgent.js"

/**
 * Background semantic audit.
 *
 * After a session goes idle, and only if the set of active memories changed
 * since the last audit and enough time has passed, a model is asked whether any
 * memories duplicate, refine or contradict each other. A store too large for one
 * prompt is audited in batches (see splitIntoBatches). Each finding becomes an
 * `intent: retire` proposal in staging, which the bot turns into a PR — the
 * human reviews and merges. There is no review.json: the PR is the durable
 * record of the suggestion and its outcome.
 *
 * The audit never edits `memory/active/` or `_summary.md`.
 */

/** Entries repeated at the start of the next batch so neighbouring pairs are not split. */
const BATCH_OVERLAP = 3
const AUDIT_STATE_FILE = "audit-state.json"

// ─── Prompt and response handling ────────────────────────────────────────────

export const AUDIT_SYSTEM_PROMPT = [
  "You audit a list of project memory entries for maintenance problems.",
  "Report only pairs or groups of entries that: duplicate each other (say the same thing),",
  "refine each other (one is a more specific or more general version of the other),",
  "or contradict each other (cannot both be followed).",
  "Entries about different topics are NOT findings. Entries on the same topic that are compatible are NOT findings.",
  "For each finding also name the single entry that should be retired (the weaker, narrower, or stale one).",
  'For a refinement, also give "superseded_by" — the broader entry that subsumes the retired one.',
  "Do not call any tools. Reply with a single JSON object and nothing else, in this shape:",
  '{"findings":[{"relation":"duplicate|refinement|contradiction","retire":"mem-XXXX","superseded_by":"mem-YYYY","reason":"one short sentence in the entries\' language"}]}',
  '"superseded_by" is required for "refinement" and optional otherwise.',
  'If there are no problems reply {"findings":[]}.',
].join("\n")

export function buildAuditPrompt(memories: Memory[]): string {
  const blocks = memories.map((m) => {
    const tags = m.tags && m.tags.length > 0 ? ` tags: ${m.tags.join(", ")}` : ""
    return `[${m.id}] ${m.title}${tags}\n${m.body}`
  })
  return `Memory entries:\n\n${blocks.join("\n\n---\n\n")}`
}

// ─── Batching ────────────────────────────────────────────────────────────────

/** Characters one entry contributes to the audit prompt (see buildAuditPrompt). */
function entrySize(m: Memory): number {
  return m.id.length + m.title.length + m.body.length + (m.tags ?? []).join(", ").length + 24
}

/** Word and CJK-bigram tokens of an entry's title, tags and body start, for similarity ordering. */
function tokensOf(m: Memory): Set<string> {
  const text = `${m.title} ${(m.tags ?? []).join(" ")} ${m.body.slice(0, 400)}`.toLowerCase()
  const out = new Set<string>()
  for (const w of text.match(/[a-z0-9_]{3,}/g) ?? []) out.add(w)
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
  }
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

/**
 * Order entries so related ones sit next to each other (greedy nearest
 * neighbour on title/tag/body similarity, starting from the lowest id). Pure and
 * deterministic, so repeated audits of the same store batch it the same way.
 */
export function orderBySimilarity(memories: Memory[]): Memory[] {
  if (memories.length <= 2) return [...memories]
  const rest = [...memories].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const tokens = new Map(rest.map((m) => [m.id, tokensOf(m)]))
  const ordered: Memory[] = [rest.shift()!]
  while (rest.length > 0) {
    const last = tokens.get(ordered[ordered.length - 1]!.id)!
    let best = 0
    let bestScore = -1
    for (let i = 0; i < rest.length; i++) {
      const score = jaccard(last, tokens.get(rest[i]!.id)!)
      if (score > bestScore) {
        bestScore = score
        best = i
      }
    }
    ordered.push(rest.splice(best, 1)[0]!)
  }
  return ordered
}

/**
 * Split entries into batches of at most `maxChars` prompt characters. A store
 * that fits is returned as one batch unchanged. Otherwise entries are ordered by
 * similarity, filled greedily, and each batch repeats the last `overlap` entries
 * of the previous one. An entry larger than the budget gets a batch of its own.
 * Pairs that land in different batches can still be missed; ordering and overlap
 * make that unlikely, not impossible.
 */
export function splitIntoBatches(memories: Memory[], maxChars: number, overlap = BATCH_OVERLAP): Memory[][] {
  const total = memories.reduce((n, m) => n + entrySize(m), 0)
  if (total <= maxChars) return [memories]

  const ordered = orderBySimilarity(memories)
  const batches: Memory[][] = []
  let cur: Memory[] = []
  let curSize = 0
  for (const m of ordered) {
    const size = entrySize(m)
    if (cur.length > 0 && curSize + size > maxChars) {
      batches.push(cur)
      const carry = cur.slice(-overlap)
      const carrySize = carry.reduce((n, c) => n + entrySize(c), 0)
      if (carry.length > 0 && carrySize + size <= maxChars) {
        cur = [...carry]
        curSize = carrySize
      } else {
        cur = []
        curSize = 0
      }
    }
    cur.push(m)
    curSize += size
  }
  if (cur.length > 0) batches.push(cur)
  return batches
}

export type AuditFinding = {
  relation: "duplicate" | "refinement" | "contradiction"
  /** ID of the active memory the audit proposes retiring. */
  retire: string
  /** For a refinement, the broader active memory that subsumes the retired one. */
  supersededBy?: string
  reason: string
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

const RELATIONS = ["duplicate", "refinement", "contradiction"] as const

/**
 * Turn a model reply into validated findings. Anything malformed or referring
 * to unknown IDs is dropped. Returns null when the reply is not a usable audit
 * result at all (so the caller can treat it as a failed run).
 */
export function parseAuditResponse(text: string, active: Memory[]): AuditFinding[] | null {
  const obj = extractJsonObject(text)
  if (!obj || typeof obj !== "object") return null
  const list = (obj as Record<string, unknown>)["findings"]
  if (!Array.isArray(list)) return null

  const activeIds = new Set(active.map((m) => m.id))
  const seen = new Set<string>()
  const out: AuditFinding[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    const relation = r["relation"]
    const retire = r["retire"]
    if (typeof relation !== "string" || !(RELATIONS as readonly string[]).includes(relation)) continue
    if (typeof retire !== "string" || !activeIds.has(retire)) continue
    if (seen.has(retire)) continue
    seen.add(retire)

    const finding: AuditFinding = {
      relation: relation as AuditFinding["relation"],
      retire,
      reason: typeof r["reason"] === "string" ? r["reason"].replace(/\s+/g, " ").trim() : "",
    }
    const by = r["superseded_by"]
    if (typeof by === "string" && by !== retire && activeIds.has(by)) finding.supersededBy = by
    out.push(finding)
  }
  return out
}

/** Map a finding relation onto the fixed retirement vocabulary. */
export function relationToReason(relation: AuditFinding["relation"]): RetiredReason {
  if (relation === "duplicate") return "duplicate"
  if (relation === "contradiction") return "wrong"
  return "superseded"
}

// ─── Guard state (machine-local; the durable record is the PR, not this) ────

type AuditRunOutcome = "done" | "failed" | "discarded-changed"

type AuditState = {
  lastHash: string
  lastAuditAt: string
  /** Outcome of the last run that reached the model (skips are not recorded). */
  lastOutcome?: AuditRunOutcome
  lastOutcomeAt?: string
  /** Clipped error text of the last failure. */
  lastError?: string
}

function auditStatePath(projectDir: string): string {
  return path.join(machineDir(projectDir), AUDIT_STATE_FILE)
}

async function readAuditState(projectDir: string): Promise<AuditState> {
  try {
    const parsed = JSON.parse(await fs.readFile(auditStatePath(projectDir), "utf8")) as Record<string, unknown>
    const state: AuditState = {
      lastHash: typeof parsed["lastHash"] === "string" ? parsed["lastHash"] : "",
      lastAuditAt: typeof parsed["lastAuditAt"] === "string" ? parsed["lastAuditAt"] : "",
    }
    const outcome = parsed["lastOutcome"]
    if (outcome === "done" || outcome === "failed" || outcome === "discarded-changed") state.lastOutcome = outcome
    if (typeof parsed["lastOutcomeAt"] === "string") state.lastOutcomeAt = parsed["lastOutcomeAt"]
    if (typeof parsed["lastError"] === "string") state.lastError = parsed["lastError"]
    return state
  } catch {
    return { lastHash: "", lastAuditAt: "" }
  }
}

async function writeAuditState(projectDir: string, state: AuditState): Promise<void> {
  await fs.mkdir(machineDir(projectDir), { recursive: true })
  await fs.writeFile(auditStatePath(projectDir), JSON.stringify(state, null, 2) + "\n", "utf8")
}

/** Stable hash of the active memories' text (order-independent). */
export function activeHash(memories: Memory[]): string {
  const parts = memories
    .map((m) => JSON.stringify([m.id, m.title, m.body, [...(m.tags ?? [])].sort()]))
    .sort()
  return crypto.createHash("sha1").update(parts.join("\n")).digest("hex")
}

// ─── One audit run ───────────────────────────────────────────────────────────

/** Sends system + user text to a model and returns the reply text. Throws on failure. */
export type ModelCall = (system: string, prompt: string) => Promise<string>

export type AuditOutcome =
  | "disabled"
  | "skipped-unchanged"
  | "skipped-interval"
  | "skipped-too-few"
  | "discarded-changed"
  | "failed"
  | "done"

export type AuditDeps = {
  directory: string
  config: PluginConfig
  logger: Logger
  call: ModelCall
  /** Show a short message to the user (e.g. a TUI toast). Called when a failure is new, never repeated for the same error. */
  notify?: (message: string) => Promise<void> | void
  now?: () => Date
  /** Bypass the minimum interval (explicit refresh). Unchanged entries are still skipped. */
  force?: boolean
}

/**
 * Run one audit if the guards allow it. Never throws. Guards, in order:
 * enabled, at least two active entries, entries changed
 * since the last completed audit, minimum interval since the last attempt.
 *
 * On success, each finding becomes an `intent: retire` staging proposal (with
 * `superseded_by` for refinements) so the bot can open a PR for it.
 */
export async function runAudit(deps: AuditDeps): Promise<AuditOutcome> {
  const { directory, config, logger, call } = deps
  const now = deps.now ?? (() => new Date())
  if (!config.backgroundAudit) return "disabled"

  try {
    const active = await listActiveMemories(directory)
    const state = await readAuditState(directory)
    const hash = activeHash(active)

    if (active.length < 2) {
      if (state.lastHash !== hash) await writeAuditState(directory, { ...state, lastHash: hash })
      return "skipped-too-few"
    }
    if (hash === state.lastHash) return "skipped-unchanged"

    if (!deps.force) {
      const last = Date.parse(state.lastAuditAt)
      if (!Number.isNaN(last) && now().getTime() - last < config.auditIntervalMinutes * 60_000) {
        return "skipped-interval"
      }
    }

    // One model call per batch. A failed or unparsable batch fails the whole run
    // before anything is written, so a retry never sees a half-applied audit.
    const batches = splitIntoBatches(active, config.auditBatchChars)
    const merged = new Map<string, AuditFinding>()
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!
      const prompt =
        batches.length > 1
          ? `Batch ${i + 1} of ${batches.length}: these are some of the project's memory entries; report only relations among the entries shown below.\n\n${buildAuditPrompt(batch)}`
          : buildAuditPrompt(batch)

      let reply: string
      try {
        reply = await call(AUDIT_SYSTEM_PROMPT, prompt)
      } catch (err) {
        await recordFailure(deps, err instanceof Error ? err.message : String(err), now())
        await logger.error("audit", err)
        return "failed"
      }

      const parsed = parseAuditResponse(reply, batch)
      if (parsed === null) {
        await recordFailure(deps, `The audit model's reply was not usable (batch ${i + 1} of ${batches.length}): ${clip(reply, 200)}`, now())
        await logger.error("audit", `unparsable audit reply (batch ${i + 1}/${batches.length}): ` + clip(reply, 200))
        return "failed"
      }
      for (const f of parsed) if (!merged.has(f.retire)) merged.set(f.retire, f)
    }
    const findings = [...merged.values()]

    // If memories changed while the model was working, the verdict may describe
    // text that no longer exists. Leave lastHash as is so the next idle re-audits.
    const fresh = await listActiveMemories(directory)
    if (activeHash(fresh) !== hash) {
      await markAttempt(directory, now(), "discarded-changed")
      await logger.info("audit", "discarded: memories changed during audit")
      return "discarded-changed"
    }

    // Emit a retire proposal per finding, skipping any already proposed.
    const staged = await listStagedProposals(directory)
    const alreadyProposed = new Set(staged.filter((p) => p.intent === "retire").map((p) => p.id))
    const titleById = new Map(active.map((m) => [m.id, m.title]))
    let emitted = 0
    for (const f of findings) {
      if (alreadyProposed.has(f.retire)) continue
      const memory: Memory = {
        id: f.retire,
        title: titleById.get(f.retire) ?? f.retire,
        body: "",
        author: "unknown",
        source: `background audit — ${f.relation}: ${f.reason || "(no reason given)"}`,
        proposedAt: now().toISOString(),
        intent: "retire",
        retiredReason: relationToReason(f.relation),
      }
      if (f.supersededBy) memory.supersededBy = f.supersededBy
      await writeProposal(directory, memory)
      emitted++
    }

    const doneAt = now().toISOString()
    await writeAuditState(directory, { lastHash: hash, lastAuditAt: doneAt, lastOutcome: "done", lastOutcomeAt: doneAt })
    await logger.info(
      "audit",
      `${findings.length} finding(s) → ${emitted} proposal(s) over ${active.length} entries in ${batches.length} batch(es)`,
    )
    return "done"
  } catch (err) {
    await recordFailure(deps, err instanceof Error ? err.message : String(err), now())
    await logger.error("audit", err)
    return "failed"
  }
}

async function markAttempt(directory: string, at: Date, outcome?: AuditRunOutcome): Promise<void> {
  const state = await readAuditState(directory)
  const next: AuditState = { ...state, lastAuditAt: at.toISOString() }
  if (outcome) {
    next.lastOutcome = outcome
    next.lastOutcomeAt = at.toISOString()
    delete next.lastError
  }
  await writeAuditState(directory, next)
}

// ─── Failure visibility ──────────────────────────────────────────────────────

/** Does a model/transport error message look like the prompt was too large for the model? */
export function looksLikeContextOverflow(message: string): boolean {
  return /context[_ -]?(length|window)|maximum context|too (long|large)|token limit|max(imum)? (input )?tokens|exceeds? (the )?(maximum|limit|context)|prompt is too long|request too large|payload too large|\b413\b/i.test(message)
}

/** What the user can do about a failure, or null when there is no specific advice. */
export function auditFailureHint(message: string, config: PluginConfig): string | null {
  if (!looksLikeContextOverflow(message)) return null
  const now = config.auditBatchChars
  const suggest = Math.max(10_000, Math.floor(now / 4))
  return `The audit prompt probably exceeds the audit model's context window. Lower "auditBatchChars" in the memory plugin options (currently ${now}), for example to ${suggest}, or point "auditModel" at a model with a larger context.`
}

/** Persist a failed run and, when the error is new, tell the user once. */
async function recordFailure(deps: AuditDeps, message: string, at: Date): Promise<void> {
  const error = clip(message.replace(/\s+/g, " ").trim(), 400)
  const state = await readAuditState(deps.directory)
  const isNew = state.lastOutcome !== "failed" || state.lastError !== error
  await writeAuditState(deps.directory, {
    ...state,
    lastAuditAt: at.toISOString(),
    lastOutcome: "failed",
    lastOutcomeAt: at.toISOString(),
    lastError: error,
  })
  if (!isNew || !deps.notify) return
  const hint = auditFailureHint(error, deps.config)
  try {
    await deps.notify(`Memory audit failed: ${clip(error, 160)}${hint ? ` — ${hint}` : ""}`)
  } catch {
    // a notification problem must never break the audit
  }
}

/** Lines for `memory_review`: how the background audit last went. */
export async function describeAuditStatus(directory: string, config: PluginConfig): Promise<string[]> {
  if (!config.backgroundAudit) return ["Disabled (backgroundAudit is off)."]
  const state = await readAuditState(directory)
  if (!state.lastOutcome) return ["Not run yet in this project."]
  const when = state.lastOutcomeAt ?? state.lastAuditAt
  if (state.lastOutcome === "done") return [`Last run: ${when} — ok`]
  if (state.lastOutcome === "discarded-changed") return [`Last run: ${when} — discarded because memories changed during the audit; it will run again.`]
  const lines = [`Last run: ${when} — FAILED`, `Error: ${state.lastError ?? "(no message)"}`]
  const hint = auditFailureHint(state.lastError ?? "", config)
  if (hint) lines.push(`Likely cause: ${hint}`)
  return lines
}

// ─── SDK-backed model call (V1) ──────────────────────────────────────────────

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

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + " …"
}
