import { tool } from "@opencode-ai/plugin/tool";
// Use the zod instance bundled with @opencode-ai/plugin to avoid version conflicts
const z = tool.schema;
import { readStore, writeStore, addEntry, updateEntry, archiveEntry, searchEntries, } from "./storage.js";
import { writeSummary } from "./summary.js";
/**
 * Create all four memory tools bound to the given plugin config and logger.
 * Each tool reads and writes from `<projectDir>/.opencode/memory/MEMORY.md`.
 */
export function createMemoryTools(config, logger) {
    // ── memory_add ────────────────────────────────────────────────────────────
    const memory_add = tool({
        description: `Persist an important piece of knowledge for future OpenCode sessions in this project.

Call this tool when:
- The user explicitly says "remember this", "记住", "save this", or similar
- You discover a reusable coding rule or project convention (naming, style, architecture)
- You fix a bug pattern that is likely to recur and a future session should know about it
- You learn a project-specific fact that would otherwise be re-discovered repeatedly
- The user corrects your behavior and the correction should persist

Do NOT call for:
- Temporary task-specific information (what file you are editing right now)
- Information already in AGENTS.md or project documentation
- Obvious general programming knowledge

After adding, the memory is immediately visible in future session system prompts.`,
        args: {
            title: z.string().max(120).describe("Short one-line title for this memory (shown in summary)"),
            content: z
                .string()
                .describe("Full content to remember. Be specific — vague memories are not useful."),
            tags: z
                .array(z.string())
                .optional()
                .describe("Optional tags for grouping, e.g. ['coding-style', 'workflow', 'architecture']"),
        },
        async execute({ title, content, tags }, context) {
            try {
                const store = await readStore(context.directory);
                const { store: updated, id } = addEntry(store, title, content, tags);
                await writeStore(context.directory, updated);
                await writeSummary(context.directory, updated, config.maxSummaryChars);
                await logger.info("memory_add", `${id}: ${title}`);
                return {
                    title: `Memory saved: ${id}`,
                    output: `Saved as [${id}]: ${title}\n\nContent:\n${content}`,
                };
            }
            catch (err) {
                await logger.error("memory_add", err);
                throw err;
            }
        },
    });
    // ── memory_update ─────────────────────────────────────────────────────────
    const memory_update = tool({
        description: `Update an existing memory entry by its ID (e.g. MEM-001).

Use this when:
- An existing memory is outdated or incorrect (API changed, preference changed)
- The user corrects or refines something already remembered
- You want to add more detail to an existing entry

You can update the title, content, or tags, or any combination.
If you are unsure of the exact ID, call memory_read first to find it.`,
        args: {
            id: z.string().regex(/^MEM-\d+$/).describe("The memory ID to update, e.g. MEM-001"),
            title: z.string().max(120).optional().describe("New title (leave empty to keep existing)"),
            content: z.string().optional().describe("New content (leave empty to keep existing)"),
            tags: z.array(z.string()).optional().describe("New tags (leave empty to keep existing)"),
        },
        async execute({ id, title, content, tags }, context) {
            try {
                const store = await readStore(context.directory);
                const updated = updateEntry(store, id, {
                    ...(title !== undefined ? { title } : {}),
                    ...(content !== undefined ? { content } : {}),
                    ...(tags !== undefined ? { tags } : {}),
                });
                if (!updated) {
                    await logger.info("memory_update", `${id} not found`);
                    return {
                        title: "Memory not found",
                        output: `No active memory with ID ${id}. Use memory_read to list all active memories.`,
                    };
                }
                await writeStore(context.directory, updated);
                await writeSummary(context.directory, updated, config.maxSummaryChars);
                const entry = updated.entries.find((e) => e.id === id);
                await logger.info("memory_update", `${id}: ${entry.title}`);
                return {
                    title: `Memory updated: ${id}`,
                    output: `Updated [${id}]: ${entry.title}\n\nContent:\n${entry.content}`,
                };
            }
            catch (err) {
                await logger.error("memory_update", err);
                throw err;
            }
        },
    });
    // ── memory_delete ─────────────────────────────────────────────────────────
    const memory_delete = tool({
        description: `Soft-delete a memory entry by its ID (moves it to the Archived section).

Use this when:
- The user says "forget this", "remove this memory", "this is no longer relevant"
- A memory is clearly obsolete (old API, old architecture, old workflow)

The entry is not permanently erased — it moves to the Archived section in MEMORY.md
so it can be reviewed or restored by editing the file directly.

If you are unsure of the exact ID, call memory_read first to find it.`,
        args: {
            id: z.string().regex(/^MEM-\d+$/).describe("The memory ID to delete, e.g. MEM-001"),
            reason: z.string().optional().describe("Optional reason for deletion (helps with auditing)"),
        },
        async execute({ id, reason }, context) {
            try {
                const store = await readStore(context.directory);
                const updated = archiveEntry(store, id);
                if (!updated) {
                    await logger.info("memory_delete", `${id} not found`);
                    return {
                        title: "Memory not found",
                        output: `No active memory with ID ${id}. Use memory_read to list all active memories.`,
                    };
                }
                await writeStore(context.directory, updated);
                await writeSummary(context.directory, updated, config.maxSummaryChars);
                const reasonNote = reason ? ` (reason: ${reason})` : "";
                await logger.info("memory_delete", `${id}${reasonNote}`);
                const note = reason ? `\nReason: ${reason}` : "";
                return {
                    title: `Memory archived: ${id}`,
                    output: `[${id}] has been moved to the Archived section.${note}`,
                };
            }
            catch (err) {
                await logger.error("memory_delete", err);
                throw err;
            }
        },
    });
    // ── memory_read ───────────────────────────────────────────────────────────
    const memory_read = tool({
        description: `Read active memory entries, optionally filtered by a keyword.

Use this when:
- You need the full content of a specific memory (the summary only shows titles)
- You want to find the ID of a memory before updating or deleting it
- You want to verify what is currently stored

Returns all active entries, or only those matching the search query.`,
        args: {
            query: z
                .string()
                .optional()
                .describe("Optional keyword to filter entries (matches title, content, and tags)"),
        },
        async execute({ query }, context) {
            const store = await readStore(context.directory);
            const entries = query ? searchEntries(store, query) : store.entries.filter((e) => !e.archived);
            if (entries.length === 0) {
                const msg = query
                    ? `No active memories matching "${query}".`
                    : "No active memories stored yet. Use memory_add to save knowledge.";
                return { title: "Memory read", output: msg };
            }
            const lines = [`Found ${entries.length} active ${entries.length === 1 ? "memory" : "memories"}:\n`];
            for (const e of entries) {
                const tags = e.tags && e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
                const updated = e.updated ? ` (updated ${e.updated})` : "";
                lines.push(`### [${e.id}]${tags} ${e.title}`);
                lines.push(`Added: ${e.added}${updated}`);
                lines.push(e.content);
                lines.push("");
            }
            return { title: `Memory read (${entries.length})`, output: lines.join("\n") };
        },
    });
    return { memory_add, memory_update, memory_delete, memory_read };
}
//# sourceMappingURL=tools.js.map