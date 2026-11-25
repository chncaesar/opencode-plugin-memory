import { tool } from "@opencode-ai/plugin/tool"
import type { ToolDefinition } from "@opencode-ai/plugin/tool"
import type { PluginConfig, Memory, RetiredReason, Scope } from "./types.js"
import type { Logger } from "./logging.js"
import { MEMORY_WRITE_POLICY } from "./prompt.js"
import {
  generateMemoryId,
  listActiveMemories,
  listRetiredMemories,
  listStagedProposals,
  memoryAge,
  resolveAuthor,
  writeProposal,
  StoreWriteError,
} from "./storage.js"
import { detectSecrets } from "./secret.js"
import { processStagingOnce } from "./bot.js"
import { describeAuditStatus } from "./audit.js"
import {
  availableStores,
  globalProblemToolMessage,
  projectProblemToolMessage,
  resolveStores,
  StoreAccessError,
  usableProjectStore,
  withStoreAccess,
  type Store,
  type StoreSet,
} from "./stores.js"

// Use the zod instance bundled with @opencode-ai/plugin to avoid version conflicts
const z = tool.schema

const ID_SCHEMA = z.string().regex(/^mem-[A-Za-z0-9_-]{8}$/)

const SCOPE_SCHEMA = z
  .enum(["global", "project"])
  .optional()
  .describe(
    "Which store receives this entry. global (default) is injected in every repository; project is shared only with whoever has this repository. " +
    "Use global unless the rule would be wrong — or pointless — in a different repository.",
  )

type MemoryToolSet = {
  memory_propose: ToolDefinition
  memory_update: ToolDefinition
  memory_delete: ToolDefinition
  memory_read: ToolDefinition
  memory_review: ToolDefinition
  memory_publish: ToolDefinition
}

/** Map a free-text retirement reason onto the fixed vocabulary (default `stale`). */
export function mapRetireReason(reason?: string): RetiredReason {
  if (!reason) return "stale"
  const r = reason.toLowerCase()
  if (/wrong|incorrect|false|错误|不正确/.test(r)) return "wrong"
  if (/duplicat|\bdup\b|重复/.test(r)) return "duplicate"
  if (/useless|pointless|无用|没用/.test(r)) return "useless"
  // Graduation: the rule is now enforced by the artifact. Checked before
  // "superseded" because "superseded by the code" describes graduation, not a
  // replacement by another memory.
  if (/implement|shipped|landed|now enforced|already built|in the code|by the code|into the code|落地|已实现|已经实现|已上线|写进代码|做进代码/.test(r)) return "implemented"
  if (/supersed|replac|取代|替代|替换/.test(r)) return "superseded"
  if (/stale|outdated|obsolete|过期|过时|陈旧/.test(r)) return "stale"
  return "stale"
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** Find an existing memory that duplicates the candidate by title or content. */
function findDuplicate(title: string, content: string, existing: Memory[]): Memory | null {
  const t = normalize(title).toLowerCase()
  const c = normalize(content)
  return (
    existing.find(
      (m) => normalize(m.title).toLowerCase() === t || (c.length > 0 && normalize(m.body) === c),
    ) ?? null
  )
}

function secretReject(logger: Logger, action: string, secrets: string[]): { title: string; output: string } {
  void logger.info(action, "rejected: secret scan")
  return {
    title: "Memory not proposed",
    output: `The content appears to contain a credential (${secrets.join(", ")}). It was not proposed. Rewrite without credentials — never store secrets or tokens in memory.`,
  }
}

/**
 * Resolve the store a proposal goes to. An explicit `scope: "global"` fails with
 * instructions when the global store is unusable; an omitted scope follows the
 * configured default and therefore falls back to the project store instead of
 * failing. A project store that could not be initialized is never returned: a
 * write into it would claim success against a store that does not exist yet.
 */
function pickStore(stores: StoreSet, requested?: Scope): { store: Store } | { error: string } {
  const wanted: Scope = requested ?? stores.defaultScope
  if (wanted === "global") {
    if (stores.global) return { store: stores.global }
    return { error: globalProblemToolMessage(stores.globalProblem ?? "missing", stores.globalPath) }
  }
  const project = usableProjectStore(stores)
  if (project) return { store: project }
  return { error: projectProblemToolMessage(stores.projectProblem ?? "unavailable", stores.project.root) }
}

/** The actionable message for an unavailable project store. */
function projectUnavailable(stores: StoreSet): string {
  return projectProblemToolMessage(stores.projectProblem ?? "unavailable", stores.project.root)
}

type ToolResult = { title: string; output: string }

/**
 * Hold the cross-process access lease for every available Git-backed store
 * across a complete read/check/write phase. Plain-directory stores have no
 * lease. A busy/recovering store is reported instead of being read or written.
 */
async function withProjectLease<T extends ToolResult>(
  stores: StoreSet,
  fn: () => Promise<T>,
): Promise<T | ToolResult> {
  const targets = availableStores(stores)
  const run = targets.reduceRight<() => Promise<T>>(
    (next, store) => () => withStoreAccess(store, next),
    fn,
  )
  try {
    return await run()
  } catch (err) {
    if (err instanceof StoreAccessError) {
      return { title: "Project memory busy", output: err.message }
    }
    throw err
  }
}

/** The store that currently holds an active memory, searched global-first. */
async function locateActive(stores: StoreSet, id: string): Promise<{ store: Store; memory: Memory } | null> {
  for (const store of availableStores(stores)) {
    const active = await listActiveMemories(store.root)
    const memory = active.find((m) => m.id === id)
    if (memory) return { store, memory }
  }
  return null
}

function scopeLabel(scope: Scope): string {
  return scope === "global" ? "global" : "project"
}

const PROPOSE_DESCRIPTION = `Propose durable knowledge for review. A proposal is a suggestion only: it becomes an active memory only after a human reviews and merges a pull request.

Store: use the \`scope\` argument. global (default) is injected in every repository; project is shared only with whoever has this repository. Most knowledge is global.

${MEMORY_WRITE_POLICY}

Proposed memories are NOT yet active. Do not propose a duplicate — first check the index and, when unsure, use memory_read.

To REPLACE an existing active memory, pass its ID in supersedes; the replacement retires the old one in the same PR (do not add and delete separately). The id must live in the same store as the proposal.`

/** How the tools resolve the stores for a session directory. Injectable for tests. */
export type StoreResolver = (directory: string) => Promise<StoreSet>

/**
 * Create the six memory tools bound to the given plugin config and logger.
 * Each write tool only ever PROPOSES: it writes a file into the chosen store's
 * `.memory/staging/`. The merged store under `memory/active/` is never edited by
 * any tool. An unavailable project store is never used as a write or read
 * target; project-scoped calls return an actionable message instead.
 */
export function createMemoryTools(
  config: PluginConfig,
  logger: Logger,
  resolve: StoreResolver = (directory) => resolveStores(directory, config),
): MemoryToolSet {
  // ── memory_propose ────────────────────────────────────────────────────────

  const memory_propose = tool({
    description: PROPOSE_DESCRIPTION,
    args: {
      title: z.string().max(120).describe(
        "Short one-line title shown in the index. Must fully represent the content: a future LLM reading only the title must be able to decide whether to load this entry. " +
        "One entry = one distinct rule or fact. If the content covers multiple independent behaviors, split into separate entries with separate titles. " +
        "Name the specific behavior, not just the domain. Bad: 'Metabase display rules'. Good: 'Metabase drill-through: use details-only to hide columns, not hidden'."
      ),
      content: z
        .string()
        .describe("Full content to remember. Be specific — vague memories are not useful."),
      tags: z
        .array(z.string())
        .optional()
        .describe("Optional tags for grouping, e.g. ['coding-style', 'workflow', 'architecture']"),
      supersedes: z
        .array(ID_SCHEMA)
        .optional()
        .describe("IDs of active memories in the same store that this proposal replaces. All IDs must be active in that store or nothing is proposed."),
      scope: SCOPE_SCHEMA,
    },
    async execute({ title, content, tags, supersedes, scope }, context) {
      const stores = await resolve(context.directory)
      return withProjectLease(stores, async () => {
      try {
        const secrets = detectSecrets(`${title}\n${content}`)
        if (secrets.length > 0) return secretReject(logger, "memory_propose", secrets)

        const picked = pickStore(stores, scope)
        if ("error" in picked) {
          await logger.info("memory_propose", `rejected: global store unavailable (${stores.globalProblem})`)
          return { title: "Memory not proposed", output: picked.error }
        }
        const target = picked.store

        if (supersedes && supersedes.length > 0) {
          const targetActive = new Set((await listActiveMemories(target.root)).map((m) => m.id))
          const unknown: string[] = []
          const wrongStore: string[] = []
          for (const id of new Set(supersedes)) {
            if (targetActive.has(id)) continue
            const elsewhere = await locateActive(stores, id)
            if (elsewhere) wrongStore.push(`${id} (${scopeLabel(elsewhere.store.scope)} store)`)
            else unknown.push(id)
          }
          if (wrongStore.length > 0) {
            await logger.info("memory_propose", `rejected: supersedes in another store ${wrongStore.join(", ")}`)
            return {
              title: "Memory not proposed",
              output:
                `Cannot supersede ${wrongStore.join(", ")} from the ${scopeLabel(target.scope)} store: a replacement must stay in the store that holds the original. ` +
                `Propose the replacement with scope "${scopeLabel(target.scope)}" only for entries in that store, and use memory_update for the others.`,
            }
          }
          if (unknown.length > 0) {
            await logger.info("memory_propose", `rejected: unknown supersedes ${unknown.join(", ")}`)
            const projectNote = stores.projectProblem
              ? ` The project store is unavailable, so its active memories could not be checked: ${projectUnavailable(stores)}`
              : ""
            return {
              title: "Memory not proposed",
              output: `Cannot supersede ${unknown.join(", ")}: not an active memory in an available store. Use memory_read to list active memory IDs.${projectNote}`,
            }
          }
        }

        // Duplicates are checked against both stores: the same rule in a second
        // store is a duplicate, not a second opinion.
        for (const store of availableStores(stores)) {
          const existing = [...(await listActiveMemories(store.root)), ...(await listStagedProposals(store.root))]
          const duplicate = findDuplicate(title, content, existing)
          if (!duplicate) continue
          await logger.info("memory_propose", `skipped: duplicate of ${duplicate.id} (${scopeLabel(store.scope)})`)
          return {
            title: "Memory not proposed",
            output:
              `A memory with the same title or content already exists in the ${scopeLabel(store.scope)} store (${duplicate.id}). ` +
              `Do not propose a duplicate — use memory_update to refine it, or give this one a distinct title if it is genuinely different.`,
          }
        }

        const id = generateMemoryId()
        const author = await resolveAuthor(context.directory)
        const memory: Memory = {
          id,
          title,
          body: content,
          author,
          source: "memory_propose",
          proposedAt: new Date().toISOString(),
          intent: "propose",
        }
        if (tags !== undefined && tags.length > 0) memory.tags = tags
        if (supersedes !== undefined && supersedes.length > 0) memory.supersedes = [...new Set(supersedes)]

        await writeProposal(target.root, memory)
        await logger.info("memory_propose", `${id} (${scopeLabel(target.scope)}): ${title}`)

        const out = [
          `Proposed [${id}] in the ${scopeLabel(target.scope)} store: ${title}`,
          "",
          "This is a proposal only. It becomes an active memory after a human reviews and merges the pull request.",
          "Staged only: no pull request exists until memory_publish runs.",
        ]
        if (memory.supersedes?.length) out.push("", `Supersedes: ${memory.supersedes.join(", ")}`)
        if (stores.projectProblem && target.scope === "global") {
          out.push("", "Note: the project store is unavailable, so this proposal was not checked against project memories.")
        }
        return { title: `Memory proposed: ${id}`, output: out.join("\n") }
      } catch (err) {
        if (err instanceof StoreWriteError) {
          await logger.info("memory_propose", "rejected: staging not writable")
          return { title: "Memory not proposed", output: err.message }
        }
        await logger.error("memory_propose", err)
        throw err
      }
      })
    },
  })

  // ── memory_update ─────────────────────────────────────────────────────────

  const memory_update = tool({
    description: `Update an existing active memory by its ID (e.g. mem-abc12345). The entry is found in whichever store holds it; the replacement is proposed in that same store.

memory_update does NOT edit the active memory. It PROPOSES a replacement: a new memory that carries supersedes: [id]. The old memory is retired and the new one becomes active only after a human merges the pull request.

Use this when:
- An existing memory is outdated or incorrect (API changed, preference changed)
- The user corrects or refines something already remembered
- You want to add more detail to an existing entry

You can update the title, content, or tags, or any combination. Fields you omit are copied from the existing memory.
If you are unsure of the exact ID, call memory_read first to find it.`,
    args: {
      id: ID_SCHEMA.describe("The memory ID to update, e.g. mem-abc12345"),
      title: z.string().max(120).optional().describe(
        "New title (leave empty to keep existing). Must fully represent the content — see memory_propose for granularity rules."
      ),
      content: z.string().optional().describe("New content (leave empty to keep existing)"),
      tags: z.array(z.string()).optional().describe("New tags (leave empty to keep existing)"),
    },
    async execute({ id, title, content, tags }, context) {
      const stores = await resolve(context.directory)
      return withProjectLease(stores, async () => {
      try {
        const found = await locateActive(stores, id)
        if (!found) {
          await logger.info("memory_update", `${id} not found in available stores`)
          if (stores.projectProblem) {
            return { title: "Project memory unavailable", output: projectUnavailable(stores) }
          }
          return {
            title: "Memory not found",
            output: `No active memory with ID ${id}. Use memory_read to list all active memories.`,
          }
        }
        const { store, memory: target } = found

        const newTitle = title !== undefined ? title : target.title
        const newContent = content !== undefined ? content : target.body
        const newTags = tags !== undefined ? tags : target.tags

        const secrets = detectSecrets(`${newTitle}\n${newContent}`)
        if (secrets.length > 0) return secretReject(logger, "memory_update", secrets)

        const newId = generateMemoryId()
        const author = await resolveAuthor(context.directory)
        const memory: Memory = {
          id: newId,
          title: newTitle,
          body: newContent,
          author,
          source: "memory_update",
          proposedAt: new Date().toISOString(),
          supersedes: [id],
          intent: "propose",
        }
        if (newTags !== undefined && newTags.length > 0) memory.tags = newTags

        await writeProposal(store.root, memory)
        await logger.info("memory_update", `${newId} supersedes ${id} (${scopeLabel(store.scope)})`)
        return {
          title: `Memory update proposed: ${newId}`,
          output: `Proposed [${newId}] in the ${scopeLabel(store.scope)} store as a replacement for [${id}]: ${newTitle}\n\nThis is a proposal only; it takes effect after a human merges the pull request.\nStaged only: no pull request exists until memory_publish runs.`,
        }
      } catch (err) {
        if (err instanceof StoreWriteError) {
          await logger.info("memory_update", "rejected: staging not writable")
          return { title: "Memory not proposed", output: err.message }
        }
        await logger.error("memory_update", err)
        throw err
      }
      })
    },
  })

  // ── memory_delete ─────────────────────────────────────────────────────────

  const memory_delete = tool({
    description: `Propose retiring an active memory by its ID. The entry is found in whichever store holds it; the retirement is proposed in that same store.

memory_delete does NOT edit the active memory. It writes a retirement proposal: a staging file naming the target id and a reason. The memory moves to retired/ only after a human merges the pull request.

Use this when:
- The user says "forget this", "remove this memory", "this is no longer relevant"
- A memory is clearly obsolete (old API, old architecture, old workflow)
- The rule graduated: it is now enforced by the code, tests or design doc, so the artifact states it and the memory only duplicates it. Retire it with reason "implemented" instead of leaving two sources of truth
- A memory is a leftover test or placeholder

Give a short reason; it is mapped to a fixed vocabulary (wrong, stale, useless, superseded, duplicate, implemented; default stale). "implemented" means the artifact now states the rule — use it when a rule lands, not when it merely goes quiet.
If you are unsure of the exact ID, call memory_read first to find it.`,
    args: {
      id: ID_SCHEMA.describe("The memory ID to retire, e.g. mem-abc12345"),
      reason: z.string().optional().describe("Short reason for retiring (mapped to a fixed vocabulary)"),
    },
    async execute({ id, reason }, context) {
      const stores = await resolve(context.directory)
      return withProjectLease(stores, async () => {
      try {
        const found = await locateActive(stores, id)
        if (!found) {
          await logger.info("memory_delete", `${id} not found in available stores`)
          if (stores.projectProblem) {
            return { title: "Project memory unavailable", output: projectUnavailable(stores) }
          }
          return {
            title: "Memory not found",
            output: `No active memory with ID ${id}. Use memory_read to list all active memories.`,
          }
        }
        const { store, memory: target } = found

        const mapped = mapRetireReason(reason)
        const author = await resolveAuthor(context.directory)
        await writeProposal(store.root, {
          id,
          title: target.title,
          body: "",
          author,
          source: "memory_delete",
          proposedAt: new Date().toISOString(),
          intent: "retire",
          retiredReason: mapped,
        })
        await logger.info("memory_delete", `${id} (${scopeLabel(store.scope)}, reason: ${mapped})`)
        return {
          title: `Memory retirement proposed: ${id}`,
          output: `Proposed retiring [${id}] from the ${scopeLabel(store.scope)} store: ${target.title}\nReason: ${mapped}.\n\nThis is a proposal only; the memory is removed after a human merges the pull request.\nStaged only: no pull request exists until memory_publish runs.`,
        }
      } catch (err) {
        if (err instanceof StoreWriteError) {
          await logger.info("memory_delete", "rejected: staging not writable")
          return { title: "Memory not proposed", output: err.message }
        }
        await logger.error("memory_delete", err)
        throw err
      }
      })
    },
  })

  // ── memory_read ───────────────────────────────────────────────────────────

  const memory_read = tool({
    description: `Read memory entries from both stores (global and project), optionally filtered by a keyword.

Use this when:
- You need the full content of a specific memory (the index only shows titles)
- You want to find the ID of a memory before updating or retiring it
- You want to verify what is currently stored

Returns full bodies of active memories from both stores, plus your own staged proposals (marked "pending — not yet merged"), so you do not propose a duplicate. Retired memories are listed only when include_retired is true.`,
    args: {
      query: z
        .string()
        .optional()
        .describe("Optional keyword to filter entries (matches id, title, content, and tags)"),
      include_retired: z
        .boolean()
        .optional()
        .describe("Also list retired memories with their retirement reason. Default false."),
    },
    async execute({ query, include_retired }, context) {
      const stores = await resolve(context.directory)
      return withProjectLease(stores, async () => {

      const q = query?.toLowerCase()
      const matches = (m: Memory) =>
        !q ||
        m.id.toLowerCase().includes(q) ||
        m.title.toLowerCase().includes(q) ||
        m.body.toLowerCase().includes(q) ||
        (m.tags ?? []).some((t) => t.toLowerCase().includes(q))

      const sections: string[] = []
      let totalActive = 0
      let totalStaged = 0

      for (const store of availableStores(stores)) {
        const label = store.scope === "global" ? "Global" : "Project"
        const active = (await listActiveMemories(store.root)).filter(matches)
        const staged = (await listStagedProposals(store.root)).filter(matches)
        const retired = include_retired ? (await listRetiredMemories(store.root)).filter(matches) : []
        totalActive += active.length
        totalStaged += staged.length

        if (active.length === 0 && staged.length === 0 && retired.length === 0) continue

        const lines: string[] = [`## ${label} store`, ""]
        lines.push(`Active memories (${active.length}):`, "")
        for (const m of active) lines.push(...formatMemory(m))
        lines.push(`Pending proposals — not yet merged (${staged.length}):`, "")
        for (const m of staged) {
          const kind = m.intent === "retire" ? "retire" : "propose"
          lines.push(`### [${m.id}] ${m.title} (${kind})`)
          if (m.intent === "retire") lines.push(`Retirement proposal (reason: ${m.retiredReason ?? "stale"}) — no body.`)
          else if (m.body) lines.push(m.body)
          lines.push("")
        }
        if (include_retired) {
          lines.push(`Retired memories (${retired.length}):`, "")
          for (const m of retired) {
            const meta = [m.retiredAt ? `retired ${m.retiredAt}` : "", m.retiredReason ? `reason: ${m.retiredReason}` : "", m.supersededBy ? `superseded by ${m.supersededBy}` : ""].filter(Boolean)
            lines.push(`### [${m.id}] ${m.title}`)
            if (meta.length) lines.push(meta.join(" | "))
            lines.push(m.body, "")
          }
        }
        sections.push(lines.join("\n"))
      }

      const availabilityNotes: string[] = []
      if (!stores.global && stores.globalProblem !== "disabled") {
        availabilityNotes.push(`Global store: unavailable. ${globalProblemToolMessage(stores.globalProblem ?? "missing", stores.globalPath)}`)
      }
      if (stores.projectProblem) {
        availabilityNotes.push(`Project store: unavailable. ${projectUnavailable(stores)}`)
      }

      if (sections.length === 0) {
        const msg = query
          ? `No memories matching "${query}" in the available stores.`
          : "No active memories in the available stores. Use memory_propose to propose knowledge."
        return { title: "Memory read", output: [msg, ...availabilityNotes].join("\n\n") }
      }

      const header: string[] = []
      for (const note of availabilityNotes) header.push(note, "")
      return {
        title: `Memory read (${totalActive}${totalStaged ? ` + ${totalStaged} pending` : ""})`,
        output: [...header, ...sections].join("\n\n"),
      }
      })
    },
  })

  // ── memory_review ─────────────────────────────────────────────────────────

  const memory_review = tool({
    description: `A read-only overview of both memory stores. Shows active memories (id + title) per store, pending proposals, aging memories, and — on request — retired memories.

Use this when the system prompt says memories need review, or when cleaning up memory. It also reports how the background audit last went for each store (including failures). It never edits anything; use memory_propose / memory_update / memory_delete to propose changes.`,
    args: {
      include_retired: z
        .boolean()
        .optional()
        .describe("Also list retired memories. Default false."),
    },
    async execute({ include_retired }, context) {
      const stores = await resolve(context.directory)
      return withProjectLease(stores, async () => {
      const now = new Date()
      const lines: string[] = []

      if (!stores.global) {
        if (stores.globalProblem === "disabled") {
          // Deliberate configuration: say it once, briefly, without a path.
          lines.push(
            "## Global store",
            stores.projectProblem
              ? "Disabled by configuration; project memory is also unavailable this session."
              : "Disabled by configuration; project memory only.",
            "",
          )
        } else {
          lines.push("## Global store", globalProblemToolMessage(stores.globalProblem ?? "missing", stores.globalPath), "")
        }
      }

      // An unavailable project store is reported, not iterated as an empty store.
      if (stores.projectProblem) {
        lines.push("## Project store", projectUnavailable(stores), "")
      }

      let totalActive = 0
      for (const store of availableStores(stores)) {
        const label = store.scope === "global" ? "Global" : "Project"
        const active = await listActiveMemories(store.root)
        const staged = await listStagedProposals(store.root)
        const retired = include_retired ? await listRetiredMemories(store.root) : []
        totalActive += active.length

        lines.push(`## ${label} store`, "", `### Active memories (${active.length})`)
        if (active.length === 0) lines.push("None.")
        for (const m of active) lines.push(`- [${m.id}] ${m.title}`)

        lines.push("", `### Pending proposals — not yet merged (${staged.length})`)
        if (staged.length === 0) lines.push("None.")
        for (const m of staged) {
          const kind = m.intent === "retire" ? "retire" : "propose"
          const note = m.intent === "retire" ? ` (retire, reason: ${m.retiredReason ?? "stale"})` : ""
          lines.push(`- [${m.id}] ${m.title} (${kind})${note}`)
        }

        const aging = active
          .map((m) => ({ memory: m, age: memoryAge(m, now) }))
          .filter((a) => !Number.isNaN(a.age) && a.age >= config.staleDays)
          .sort((a, b) => b.age - a.age)
        lines.push("", `### Aging memories (not touched for ${config.staleDays}+ days)`)
        if (aging.length === 0) lines.push("None.")
        for (const a of aging) lines.push(`- [${a.memory.id}] ${a.memory.title} (${a.age} days)`)

        lines.push("", "### Background audit")
        lines.push(...(await describeAuditStatus(store.root, config)))

        if (include_retired) {
          lines.push("", `### Retired memories (${retired.length})`)
          if (retired.length === 0) lines.push("None.")
          for (const m of retired) lines.push(`- [${m.id}] ${m.title}${m.retiredReason ? ` (${m.retiredReason})` : ""}`)
        }
        lines.push("")
      }

      if (totalActive > 0) {
        lines.push("For aging memories: check whether they still hold. If yes, propose a refresh with memory_update; if not, memory_delete with a reason.")
      }

      return { title: `Memory review (${totalActive} active)`, output: lines.join("\n") }
      })
    },
  })

  // ── memory_publish ────────────────────────────────────────────────────────

  const memory_publish = tool({
    description: `Publish staged memory proposals as pull requests, in every store that has pending proposals.

Each store publishes into its own repository: global proposals open a pull request against the private memory repository, project proposals against the current repository.

Safe to call without asking the user: it runs the memory bot in a throwaway git worktree per store, so the user's checkout, branch and uncommitted files are never touched, and it only opens PRs. The human merge is the approval gate; nothing becomes an active memory until a person merges. It takes no arguments and cannot run arbitrary git commands.

Returns the opened PR URLs, grouped by store. Proposals whose push or PR step failed stay staged and are retried on the next call; one store failing never blocks the other.`,
    args: {},
    async execute(_args, context) {
      const stores = await resolve(context.directory)
      return withProjectLease(stores, async () => {
      const targets = availableStores(stores)
      const sections: string[] = []
      let promoted = 0
      let recovered = 0
      let skipped = 0
      let failed = 0
      const prs: string[] = []

      for (const store of targets) {
        const label = store.scope === "global" ? "Global" : "Project"
        try {
          const lines: string[] = []
          const res = await processStagingOnce(store.root, { log: (l) => lines.push(l) })
          const handled = res.promoted + res.recovered + res.skipped + res.failed
          if (res.busy) {
            sections.push(`${label} store: another bot run is in progress; nothing was processed.`)
            continue
          }
          if (handled === 0) continue
          promoted += res.promoted
          recovered += res.recovered
          skipped += res.skipped
          failed += res.failed
          prs.push(...res.prs)
          const summary = `${label} store: opened ${res.promoted}; recovered ${res.recovered} already-pushed; skipped ${res.skipped}; failed ${res.failed}.`
          sections.push(lines.length > 0 ? `${summary}\n${lines.map((l) => `  ${l}`).join("\n")}` : summary)
        } catch (err) {
          failed += 1
          sections.push(`${label} store: could not publish — ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // Project proposals cannot be published while its managed store is
      // unavailable; say so instead of implying there were none.
      if (stores.projectProblem) {
        sections.push(`Project store: unavailable — no project proposals were published. ${projectUnavailable(stores)}`)
      }

      await logger.info("memory_publish", `promoted=${promoted} recovered=${recovered} skipped=${skipped} failed=${failed}`)

      if (sections.length === 0) {
        const note = stores.global
          ? "No staged proposals."
          : `No staged proposals. ${globalProblemToolMessage(stores.globalProblem ?? "missing", stores.globalPath)}`
        return { title: "Memory publish", output: note }
      }

      const out = [`Opened ${promoted} PR${promoted === 1 ? "" : "s"}; recovered ${recovered} already-pushed; skipped ${skipped}; failed ${failed}.`]
      if (prs.length) out.push("", ...prs.map((u) => `- ${u}`))
      out.push("", ...sections)
      return { title: `Memory published (${promoted})`, output: out.join("\n") }
      })
    },
  })

  return { memory_propose, memory_update, memory_delete, memory_read, memory_review, memory_publish }
}

function formatMemory(m: Memory): string[] {
  const tags = m.tags && m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : ""
  const lines = [`### [${m.id}]${tags} ${m.title}`]
  const meta = [m.approvedAt ? `approved ${m.approvedAt}` : ""].filter(Boolean)
  if (meta.length) lines.push(meta.join(" | "))
  lines.push(m.body, "")
  return lines
}
