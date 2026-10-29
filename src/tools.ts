import { tool } from "@opencode-ai/plugin/tool"
import type { ToolDefinition } from "@opencode-ai/plugin/tool"
import type { PluginConfig } from "./types.js"
import type { Logger } from "./logging.js"
import { MEMORY_WRITE_POLICY } from "./prompt.js"

// Use the zod instance bundled with @opencode-ai/plugin to avoid version conflicts
const z = tool.schema

type MemoryToolSet = {
  memory_add: ToolDefinition
  memory_update: ToolDefinition
  memory_delete: ToolDefinition
  memory_read: ToolDefinition
  memory_review: ToolDefinition
}

import {
  readStore,
  writeStore,
  addEntry,
  addSupersedingEntry,
  updateEntry,
  archiveEntry,
  searchEntries,
} from "./storage.js"
import { writeSummary } from "./summary.js"
import type { AuditOutcome } from "./audit.js"
import {
  activeEntries,
  collectAttention,
  dismissItems,
  findAging,
  formatReview,
  readReviewState,
  writeReviewState,
} from "./review.js"

export type ToolDeps = {
  /** Runs a forced audit (bypasses the interval) and returns its outcome. */
  runAuditNow?: () => Promise<AuditOutcome>
}

/**
 * Create all five memory tools bound to the given plugin config and logger.
 * Each tool reads and writes from `<projectDir>/.opencode/memory/MEMORY.md`.
 */
export function createMemoryTools(config: PluginConfig, logger: Logger, deps: ToolDeps = {}): MemoryToolSet {
  // ── memory_add ────────────────────────────────────────────────────────────

  const memory_add = tool({
    description: `Persist durable knowledge for future OpenCode sessions in this project. User corrections and confirmed preferences are high-priority memories, even when the user does not explicitly ask you to remember them.

${MEMORY_WRITE_POLICY}

After adding, the memory is immediately visible in future session system prompts. Similarity between memories is judged by a model in the background audit, not by this tool: if you suspect the new entry duplicates or contradicts an existing one, call memory_review with refresh=true.

To REPLACE an existing memory, pass its ID in supersedes. The old entry is archived with a link to the new one in the same step; do not add and delete separately.`,
    args: {
      title: z.string().max(120).describe(
        "Short one-line title shown in the summary. Must fully represent the content: a future LLM reading only the title must be able to decide whether to load this entry. " +
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
        .array(z.string().regex(/^MEM-\d+$/))
        .optional()
        .describe("IDs of active memories this entry replaces (e.g. ['MEM-004']). They are archived and linked to the new entry. All IDs must be active or nothing is saved."),
    },
    async execute({ title, content, tags, supersedes }, context) {
      try {
        const store = await readStore(context.directory)
        let updated = store
        let id: string
        let archivedIds: string[] = []

        if (supersedes && supersedes.length > 0) {
          const r = addSupersedingEntry(store, title, content, tags, supersedes)
          if (!r.ok) {
            await logger.info("memory_add", `rejected: ${r.error}`)
            return {
              title: "Memory not saved",
              output: `${r.error}\nUse memory_read to list active memory IDs.`,
            }
          }
          updated = r.store
          id = r.id
          archivedIds = r.archivedIds
        } else {
          const r = addEntry(store, title, content, tags)
          updated = r.store
          id = r.id
        }

        await writeStore(context.directory, updated)
        await writeSummary(context.directory, updated, config.maxSummaryChars)
        await logger.info(
          "memory_add",
          `${id}: ${title}${archivedIds.length ? ` (supersedes ${archivedIds.join(", ")})` : ""}`,
        )

        const out: string[] = [`Saved as [${id}]: ${title}`, "", "Content:", content]
        if (archivedIds.length > 0) {
          out.push("", `Archived (superseded by ${id}): ${archivedIds.join(", ")}`)
        }

        if (activeEntries(updated).filter((e) => e.id !== id).length > 0) {
          out.push(
            "",
            "If this entry may duplicate or contradict an existing memory, call memory_review with refresh=true to run the semantic check now, or wait for the background audit.",
          )
        }

        return { title: `Memory saved: ${id}`, output: out.join("\n") }
      } catch (err) {
        await logger.error("memory_add", err)
        throw err
      }
    },
  })

  // ── memory_update ─────────────────────────────────────────────────────────

  const memory_update = tool({
    description: `Update an existing memory entry by its ID (e.g. MEM-001).

Use this when:
- An existing memory is outdated or incorrect (API changed, preference changed)
- The user corrects or refines something already remembered
- You want to add more detail to an existing entry
- You checked an entry (for example one listed as aging in memory_review) and it still holds: call with only the id to re-confirm it. This refreshes its updated date and changes nothing else.

You can update the title, content, or tags, or any combination.
If the change reverses the entry's meaning or replaces it with a different rule, use memory_add with supersedes instead, so the history is kept.
If you are unsure of the exact ID, call memory_read first to find it.`,
    args: {
      id: z.string().regex(/^MEM-\d+$/).describe("The memory ID to update, e.g. MEM-001"),
      title: z.string().max(120).optional().describe(
        "New title (leave empty to keep existing). Must fully represent the content — see memory_add for granularity rules."
      ),
      content: z.string().optional().describe("New content (leave empty to keep existing)"),
      tags: z.array(z.string()).optional().describe("New tags (leave empty to keep existing)"),
    },
    async execute({ id, title, content, tags }, context) {
      try {
        const store = await readStore(context.directory)
        const before = store.entries.find((e) => e.id === id && !e.archived)
        const updated = updateEntry(store, id, {
          ...(title !== undefined ? { title } : {}),
          ...(content !== undefined ? { content } : {}),
          ...(tags !== undefined ? { tags } : {}),
        })
        if (!updated) {
          await logger.info("memory_update", `${id} not found`)
          return {
            title: "Memory not found",
            output: `No active memory with ID ${id}. Use memory_read to list all active memories.`,
          }
        }
        await writeStore(context.directory, updated)
        await writeSummary(context.directory, updated, config.maxSummaryChars)
        const entry = updated.entries.find((e) => e.id === id)!
        const changed = before && (before.title !== entry.title || before.content !== entry.content)
        await logger.info(
          "memory_update",
          changed
            ? `${id}: ${entry.title} | previous=${JSON.stringify({ title: before.title, content: before.content, tags: before.tags ?? [] })}`
            : `${id}: ${entry.title} (reconfirmed or tags only)`,
        )
        return {
          title: `Memory updated: ${id}`,
          output: `Updated [${id}]: ${entry.title}\n\nContent:\n${entry.content}`,
        }
      } catch (err) {
        await logger.error("memory_update", err)
        throw err
      }
    },
  })

  // ── memory_delete ─────────────────────────────────────────────────────────

  const memory_delete = tool({
    description: `Soft-delete a memory entry by its ID (moves it to the Archived section).

Use this when:
- The user says "forget this", "remove this memory", "this is no longer relevant"
- A memory is clearly obsolete (old API, old architecture, old workflow)
- A memory is a leftover test or placeholder

Always give a short reason; it is stored on the archived entry. If another existing memory replaces this one, pass its ID as superseded_by. To replace a memory with NEW content, prefer memory_add with supersedes, which does both steps at once.

The entry is not permanently erased — it moves to the Archived section in MEMORY.md and can be listed with memory_read include_archived. Restoring means editing the file or adding a new memory.

If you are unsure of the exact ID, call memory_read first to find it.`,
    args: {
      id: z.string().regex(/^MEM-\d+$/).describe("The memory ID to delete, e.g. MEM-001"),
      reason: z.string().optional().describe("Short reason for archiving (stored on the entry; strongly recommended)"),
      superseded_by: z
        .string()
        .regex(/^MEM-\d+$/)
        .optional()
        .describe("ID of the active memory that replaces this one, if any"),
    },
    async execute({ id, reason, superseded_by }, context) {
      try {
        const store = await readStore(context.directory)
        if (superseded_by) {
          if (superseded_by === id || !store.entries.some((e) => e.id === superseded_by && !e.archived)) {
            return {
              title: "Memory not archived",
              output: `superseded_by ${superseded_by} must be a different, active memory. Nothing was changed.`,
            }
          }
        }
        const updated = archiveEntry(store, id, {
          ...(reason !== undefined ? { reason } : {}),
          ...(superseded_by !== undefined ? { supersededBy: superseded_by } : {}),
        })
        if (!updated) {
          await logger.info("memory_delete", `${id} not found`)
          return {
            title: "Memory not found",
            output: `No active memory with ID ${id}. Use memory_read to list all active memories.`,
          }
        }
        await writeStore(context.directory, updated)
        await writeSummary(context.directory, updated, config.maxSummaryChars)
        const reasonNote = reason ? ` (reason: ${reason})` : ""
        const linkNote = superseded_by ? ` (superseded by ${superseded_by})` : ""
        await logger.info("memory_delete", `${id}${reasonNote}${linkNote}`)
        const notes = [
          reason ? `Reason: ${reason}` : "",
          superseded_by ? `Superseded by: ${superseded_by}` : "",
        ].filter(Boolean)
        return {
          title: `Memory archived: ${id}`,
          output: [`[${id}] has been moved to the Archived section.`, ...notes].join("\n"),
        }
      } catch (err) {
        await logger.error("memory_delete", err)
        throw err
      }
    },
  })

  // ── memory_read ───────────────────────────────────────────────────────────

  const memory_read = tool({
    description: `Read active memory entries, optionally filtered by a keyword.

Use this when:
- You need the full content of a specific memory (the summary only shows titles)
- You want to find the ID of a memory before updating or deleting it
- You want to verify what is currently stored
- You want to see why something was archived or what replaced it (set include_archived)

Returns all active entries, or only those matching the search query. Archived entries are listed only when include_archived is true.`,
    args: {
      query: z
        .string()
        .optional()
        .describe("Optional keyword to filter entries (matches title, content, and tags)"),
      include_archived: z
        .boolean()
        .optional()
        .describe("Also list archived entries with their archive date, reason and replacement. Default false."),
    },
    async execute({ query, include_archived }, context) {
      const store = await readStore(context.directory)
      const entries = query ? searchEntries(store, query) : store.entries.filter((e) => !e.archived)
      const q = query?.toLowerCase()
      const archived = include_archived
        ? store.entries.filter(
            (e) =>
              e.archived &&
              (!q ||
                e.title.toLowerCase().includes(q) ||
                e.content.toLowerCase().includes(q) ||
                (e.tags ?? []).some((t) => t.toLowerCase().includes(q))),
          )
        : []

      if (entries.length === 0 && archived.length === 0) {
        const msg = query
          ? `No ${include_archived ? "" : "active "}memories matching "${query}".`
          : "No active memories stored yet. Use memory_add to save knowledge."
        return { title: "Memory read", output: msg }
      }

      const lines: string[] = []
      if (entries.length > 0 || !include_archived) {
        lines.push(`Found ${entries.length} active ${entries.length === 1 ? "memory" : "memories"}:\n`)
      }
      for (const e of entries) {
        const tags = e.tags && e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : ""
        const updated = e.updated ? ` (updated ${e.updated})` : ""
        lines.push(`### [${e.id}]${tags} ${e.title}`)
        lines.push(`Added: ${e.added}${updated}`)
        lines.push(e.content)
        lines.push("")
      }

      if (include_archived) {
        lines.push(`Archived (${archived.length}):\n`)
        for (const e of archived) {
          const tags = e.tags && e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : ""
          lines.push(`### [${e.id}]${tags} ${e.title}`)
          const meta = [`Added: ${e.added}`]
          if (e.archivedAt) meta.push(`archived ${e.archivedAt}`)
          if (e.archivedReason) meta.push(`reason: ${e.archivedReason}`)
          if (e.supersededBy) meta.push(`superseded by ${e.supersededBy}`)
          lines.push(meta.join(" | "))
          lines.push(e.content)
          lines.push("")
        }
      }

      return {
        title: `Memory read (${entries.length}${include_archived ? ` + ${archived.length} archived` : ""})`,
        output: lines.join("\n"),
      }
    },
  })

  // ── memory_review ─────────────────────────────────────────────────────────

  const memory_review = tool({
    description: `List memories that may need maintenance, and record decisions to keep them as they are.

Use this when the system prompt says memories need review, or when asked to clean up memory. It shows:
- Possible conflicts found by the background audit (duplicate, refinement, contradiction), with the full text of the entries involved
- Placeholder-like entries (test or temporary leftovers)
- Aging entries that have not been touched for a long time (informational)

Similarity is judged by a model, never by keyword matching. Set refresh to run that semantic audit immediately (bypassing the usual interval) and return its findings; otherwise cached findings are shown.

For each item decide, then act with the other memory tools: merge or replace with memory_add supersedes, correct with memory_update, remove with memory_delete (give a reason). If two entries legitimately coexist, or a placeholder is intentional, pass its key in dismiss; it will not be raised again until one of the entries changes.`,
    args: {
      dismiss: z
        .array(z.string())
        .optional()
        .describe("Item keys (as shown in the review output) to record as 'keep as is'"),
      refresh: z
        .boolean()
        .optional()
        .describe("Run the semantic audit now instead of showing cached findings. Use after a write that may duplicate or contradict an existing memory."),
    },
    async execute({ dismiss, refresh }, context) {
      try {
        const notes: string[] = []

        if (refresh) {
          if (!config.backgroundAudit) {
            notes.push("Background audit is disabled; showing cached findings.")
          } else if (deps.runAuditNow) {
            notes.push(`Audit run: ${await deps.runAuditNow()}.`)
          }
        }

        const store = await readStore(context.directory)
        let state = await readReviewState(context.directory)

        if (dismiss && dismiss.length > 0) {
          const out = dismissItems(store, state, dismiss)
          state = out.state
          if (out.dismissed.length > 0) {
            await writeReviewState(context.directory, state)
            notes.push(`Dismissed: ${out.dismissed.join(", ")}`)
            await logger.info("memory_review", `dismissed ${out.dismissed.join(", ")}`)
          }
          if (out.unknown.length > 0) {
            notes.push(`Not a current review item (ignored): ${out.unknown.join(", ")}`)
          }
        }

        const items = collectAttention(store, state)
        const aging = findAging(store, config.staleDays)
        const body = formatReview(store, items, aging, config.staleDays, {
          lastAuditAt: state.lastAuditAt,
          enabled: config.backgroundAudit,
        })
        return {
          title: `Memory review (${items.length} item${items.length === 1 ? "" : "s"})`,
          output: [...notes, ...(notes.length ? [""] : []), body].join("\n"),
        }
      } catch (err) {
        await logger.error("memory_review", err)
        throw err
      }
    },
  })

  return { memory_add, memory_update, memory_delete, memory_read, memory_review }
}
