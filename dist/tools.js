import { tool } from "@opencode-ai/plugin/tool";
import { MEMORY_WRITE_POLICY } from "./prompt.js";
import { generateMemoryId, listActiveMemories, listRetiredMemories, listStagedProposals, memoryAge, resolveAuthor, writeProposal, StoreWriteError, } from "./storage.js";
import { detectSecrets } from "./secret.js";
import { processStagingOnce } from "./bot.js";
// Use the zod instance bundled with @opencode-ai/plugin to avoid version conflicts
const z = tool.schema;
const ID_SCHEMA = z.string().regex(/^mem-[A-Za-z0-9_-]{8}$/);
/** Map a free-text retirement reason onto the fixed vocabulary (default `stale`). */
export function mapRetireReason(reason) {
    if (!reason)
        return "stale";
    const r = reason.toLowerCase();
    if (/wrong|incorrect|false|错误|不正确/.test(r))
        return "wrong";
    if (/duplicat|\bdup\b|重复/.test(r))
        return "duplicate";
    if (/useless|pointless|无用|没用/.test(r))
        return "useless";
    if (/supersed|replac|取代|替代|替换/.test(r))
        return "superseded";
    if (/stale|outdated|obsolete|过期|过时|陈旧/.test(r))
        return "stale";
    return "stale";
}
function normalize(text) {
    return text.replace(/\s+/g, " ").trim();
}
/** Find an existing memory that duplicates the candidate by title or content. */
function findDuplicate(title, content, existing) {
    const t = normalize(title).toLowerCase();
    const c = normalize(content);
    return (existing.find((m) => normalize(m.title).toLowerCase() === t || (c.length > 0 && normalize(m.body) === c)) ?? null);
}
function secretReject(logger, action, secrets) {
    void logger.info(action, "rejected: secret scan");
    return {
        title: "Memory not proposed",
        output: `The content appears to contain a credential (${secrets.join(", ")}). It was not proposed. Rewrite without credentials — never store secrets or tokens in project memory.`,
    };
}
const PROPOSE_DESCRIPTION = `Propose durable project knowledge for review. A proposal is a suggestion only: it becomes an active memory only after a human reviews and merges a pull request.

${MEMORY_WRITE_POLICY}

Proposed memories are NOT yet active. Do not propose a duplicate — first check the index and, when unsure, use memory_read.

To REPLACE an existing active memory, pass its ID in supersedes; the replacement retires the old one in the same PR (do not add and delete separately).`;
/**
 * Create the five memory tools bound to the given plugin config and logger.
 * Each tool only ever PROPOSES: it writes a file into `.memory/staging/`. The
 * merged store under `memory/active/` is never edited by any tool.
 */
export function createMemoryTools(config, logger) {
    // ── memory_propose ────────────────────────────────────────────────────────
    const memory_propose = tool({
        description: PROPOSE_DESCRIPTION,
        args: {
            title: z.string().max(120).describe("Short one-line title shown in the index. Must fully represent the content: a future LLM reading only the title must be able to decide whether to load this entry. " +
                "One entry = one distinct rule or fact. If the content covers multiple independent behaviors, split into separate entries with separate titles. " +
                "Name the specific behavior, not just the domain. Bad: 'Metabase display rules'. Good: 'Metabase drill-through: use details-only to hide columns, not hidden'."),
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
                .describe("IDs of active memories this proposal replaces. All IDs must be active or nothing is proposed."),
        },
        async execute({ title, content, tags, supersedes }, context) {
            try {
                const secrets = detectSecrets(`${title}\n${content}`);
                if (secrets.length > 0)
                    return secretReject(logger, "memory_propose", secrets);
                const active = await listActiveMemories(context.directory);
                if (supersedes && supersedes.length > 0) {
                    const activeIds = new Set(active.map((m) => m.id));
                    const bad = [...new Set(supersedes)].filter((id) => !activeIds.has(id));
                    if (bad.length > 0) {
                        await logger.info("memory_propose", `rejected: unknown supersedes ${bad.join(", ")}`);
                        return {
                            title: "Memory not proposed",
                            output: `Cannot supersede ${bad.join(", ")}: not an active memory. Use memory_read to list active memory IDs.`,
                        };
                    }
                }
                const staged = await listStagedProposals(context.directory);
                const duplicate = findDuplicate(title, content, [...active, ...staged]);
                if (duplicate) {
                    await logger.info("memory_propose", `skipped: duplicate of ${duplicate.id}`);
                    return {
                        title: "Memory not proposed",
                        output: `A memory with the same title or content already exists (${duplicate.id}). Do not propose a duplicate — skip this one.`,
                    };
                }
                const id = generateMemoryId();
                const author = await resolveAuthor(context.directory);
                const memory = {
                    id,
                    title,
                    body: content,
                    author,
                    source: "memory_propose",
                    proposedAt: new Date().toISOString(),
                    intent: "propose",
                };
                if (tags !== undefined && tags.length > 0)
                    memory.tags = tags;
                if (supersedes !== undefined && supersedes.length > 0)
                    memory.supersedes = [...new Set(supersedes)];
                await writeProposal(context.directory, memory);
                await logger.info("memory_propose", `${id}: ${title}`);
                const out = [
                    `Proposed [${id}]: ${title}`,
                    "",
                    "This is a proposal only. It becomes an active memory after a human reviews and merges the pull request.",
                    "Staged only: no pull request exists until memory_publish runs.",
                ];
                if (memory.supersedes?.length)
                    out.push("", `Supersedes: ${memory.supersedes.join(", ")}`);
                return { title: `Memory proposed: ${id}`, output: out.join("\n") };
            }
            catch (err) {
                if (err instanceof StoreWriteError) {
                    await logger.info("memory_propose", "rejected: staging not writable");
                    return { title: "Memory not proposed", output: err.message };
                }
                await logger.error("memory_propose", err);
                throw err;
            }
        },
    });
    // ── memory_update ─────────────────────────────────────────────────────────
    const memory_update = tool({
        description: `Update an existing active memory by its ID (e.g. mem-abc12345).

memory_update does NOT edit the active memory. It PROPOSES a replacement: a new memory that carries supersedes: [id]. The old memory is retired and the new one becomes active only after a human merges the pull request.

Use this when:
- An existing memory is outdated or incorrect (API changed, preference changed)
- The user corrects or refines something already remembered
- You want to add more detail to an existing entry

You can update the title, content, or tags, or any combination. Fields you omit are copied from the existing memory.
If you are unsure of the exact ID, call memory_read first to find it.`,
        args: {
            id: ID_SCHEMA.describe("The memory ID to update, e.g. mem-abc12345"),
            title: z.string().max(120).optional().describe("New title (leave empty to keep existing). Must fully represent the content — see memory_propose for granularity rules."),
            content: z.string().optional().describe("New content (leave empty to keep existing)"),
            tags: z.array(z.string()).optional().describe("New tags (leave empty to keep existing)"),
        },
        async execute({ id, title, content, tags }, context) {
            try {
                const active = await listActiveMemories(context.directory);
                const target = active.find((m) => m.id === id);
                if (!target) {
                    await logger.info("memory_update", `${id} not found`);
                    return {
                        title: "Memory not found",
                        output: `No active memory with ID ${id}. Use memory_read to list all active memories.`,
                    };
                }
                const newTitle = title !== undefined ? title : target.title;
                const newContent = content !== undefined ? content : target.body;
                const newTags = tags !== undefined ? tags : target.tags;
                const secrets = detectSecrets(`${newTitle}\n${newContent}`);
                if (secrets.length > 0)
                    return secretReject(logger, "memory_update", secrets);
                const newId = generateMemoryId();
                const author = await resolveAuthor(context.directory);
                const memory = {
                    id: newId,
                    title: newTitle,
                    body: newContent,
                    author,
                    source: "memory_update",
                    proposedAt: new Date().toISOString(),
                    supersedes: [id],
                    intent: "propose",
                };
                if (newTags !== undefined && newTags.length > 0)
                    memory.tags = newTags;
                await writeProposal(context.directory, memory);
                await logger.info("memory_update", `${newId} supersedes ${id}`);
                return {
                    title: `Memory update proposed: ${newId}`,
                    output: `Proposed [${newId}] as a replacement for [${id}]: ${newTitle}\n\nThis is a proposal only; it takes effect after a human merges the pull request.\nStaged only: no pull request exists until memory_publish runs.`,
                };
            }
            catch (err) {
                if (err instanceof StoreWriteError) {
                    await logger.info("memory_update", "rejected: staging not writable");
                    return { title: "Memory not proposed", output: err.message };
                }
                await logger.error("memory_update", err);
                throw err;
            }
        },
    });
    // ── memory_delete ─────────────────────────────────────────────────────────
    const memory_delete = tool({
        description: `Propose retiring an active memory by its ID.

memory_delete does NOT edit the active memory. It writes a retirement proposal: a staging file naming the target id and a reason. The memory moves to retired/ only after a human merges the pull request.

Use this when:
- The user says "forget this", "remove this memory", "this is no longer relevant"
- A memory is clearly obsolete (old API, old architecture, old workflow)
- A memory is a leftover test or placeholder

Give a short reason; it is mapped to a fixed vocabulary (wrong, stale, useless, superseded, duplicate; default stale).
If you are unsure of the exact ID, call memory_read first to find it.`,
        args: {
            id: ID_SCHEMA.describe("The memory ID to retire, e.g. mem-abc12345"),
            reason: z.string().optional().describe("Short reason for retiring (mapped to a fixed vocabulary)"),
        },
        async execute({ id, reason }, context) {
            try {
                const active = await listActiveMemories(context.directory);
                const target = active.find((m) => m.id === id);
                if (!target) {
                    await logger.info("memory_delete", `${id} not found`);
                    return {
                        title: "Memory not found",
                        output: `No active memory with ID ${id}. Use memory_read to list all active memories.`,
                    };
                }
                const mapped = mapRetireReason(reason);
                const author = await resolveAuthor(context.directory);
                await writeProposal(context.directory, {
                    id,
                    title: target.title,
                    body: "",
                    author,
                    source: "memory_delete",
                    proposedAt: new Date().toISOString(),
                    intent: "retire",
                    retiredReason: mapped,
                });
                await logger.info("memory_delete", `${id} (reason: ${mapped})`);
                return {
                    title: `Memory retirement proposed: ${id}`,
                    output: `Proposed retiring [${id}]: ${target.title}\nReason: ${mapped}.\n\nThis is a proposal only; the memory is removed after a human merges the pull request.\nStaged only: no pull request exists until memory_publish runs.`,
                };
            }
            catch (err) {
                if (err instanceof StoreWriteError) {
                    await logger.info("memory_delete", "rejected: staging not writable");
                    return { title: "Memory not proposed", output: err.message };
                }
                await logger.error("memory_delete", err);
                throw err;
            }
        },
    });
    // ── memory_read ───────────────────────────────────────────────────────────
    const memory_read = tool({
        description: `Read memory entries, optionally filtered by a keyword.

Use this when:
- You need the full content of a specific memory (the index only shows titles)
- You want to find the ID of a memory before updating or retiring it
- You want to verify what is currently stored

Returns full bodies of active memories, plus your own staged proposals (marked "pending — not yet merged"), so you do not propose a duplicate. Retired memories are listed only when include_retired is true.`,
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
            const active = await listActiveMemories(context.directory);
            const retired = include_retired ? await listRetiredMemories(context.directory) : [];
            const staged = await listStagedProposals(context.directory);
            const q = query?.toLowerCase();
            const matches = (m) => !q ||
                m.id.toLowerCase().includes(q) ||
                m.title.toLowerCase().includes(q) ||
                m.body.toLowerCase().includes(q) ||
                (m.tags ?? []).some((t) => t.toLowerCase().includes(q));
            const activeOut = active.filter(matches);
            const retiredOut = retired.filter(matches);
            const stagedOut = staged.filter(matches);
            if (activeOut.length === 0 && retiredOut.length === 0 && stagedOut.length === 0) {
                const msg = query
                    ? `No memories matching "${query}".`
                    : "No active memories yet. Use memory_propose to propose knowledge.";
                return { title: "Memory read", output: msg };
            }
            const lines = [];
            lines.push(`Active memories (${activeOut.length}):\n`);
            for (const m of activeOut)
                lines.push(...formatMemory(m));
            lines.push(`Pending proposals — not yet merged (${stagedOut.length}):\n`);
            for (const m of stagedOut) {
                const kind = m.intent === "retire" ? "retire" : "propose";
                lines.push(`### [${m.id}] ${m.title} (${kind})`);
                if (m.intent === "retire")
                    lines.push(`Retirement proposal (reason: ${m.retiredReason ?? "stale"}) — no body.`);
                else if (m.body)
                    lines.push(m.body);
                lines.push("");
            }
            if (include_retired) {
                lines.push(`Retired memories (${retiredOut.length}):\n`);
                for (const m of retiredOut) {
                    const meta = [m.retiredAt ? `retired ${m.retiredAt}` : "", m.retiredReason ? `reason: ${m.retiredReason}` : "", m.supersededBy ? `superseded by ${m.supersededBy}` : ""].filter(Boolean);
                    lines.push(`### [${m.id}] ${m.title}`);
                    if (meta.length)
                        lines.push(meta.join(" | "));
                    lines.push(m.body, "");
                }
            }
            const total = activeOut.length + (include_retired ? retiredOut.length : 0);
            return { title: `Memory read (${total}${stagedOut.length ? ` + ${stagedOut.length} pending` : ""})`, output: lines.join("\n") };
        },
    });
    // ── memory_review ─────────────────────────────────────────────────────────
    const memory_review = tool({
        description: `A read-only overview of the memory store. Shows active memories (id + title), pending proposals, aging memories, and — on request — retired memories.

Use this when the system prompt says memories need review, or when cleaning up memory. It never edits anything; use memory_propose / memory_update / memory_delete to propose changes.`,
        args: {
            include_retired: z
                .boolean()
                .optional()
                .describe("Also list retired memories. Default false."),
        },
        async execute({ include_retired }, context) {
            const active = await listActiveMemories(context.directory);
            const staged = await listStagedProposals(context.directory);
            const retired = include_retired ? await listRetiredMemories(context.directory) : [];
            const now = new Date();
            const aging = active
                .map((m) => ({ memory: m, age: memoryAge(m, now) }))
                .filter((a) => !Number.isNaN(a.age) && a.age >= config.staleDays)
                .sort((a, b) => b.age - a.age);
            const lines = [];
            lines.push(`## Active memories (${active.length})`);
            if (active.length === 0)
                lines.push("None.");
            for (const m of active)
                lines.push(`- [${m.id}] ${m.title}`);
            lines.push("", `## Pending proposals — not yet merged (${staged.length})`);
            if (staged.length === 0)
                lines.push("None.");
            for (const m of staged) {
                const kind = m.intent === "retire" ? "retire" : "propose";
                const note = m.intent === "retire" ? ` (retire, reason: ${m.retiredReason ?? "stale"})` : "";
                lines.push(`- [${m.id}] ${m.title} (${kind})${note}`);
            }
            lines.push("", `## Aging memories (not touched for ${config.staleDays}+ days)`);
            if (aging.length === 0)
                lines.push("None.");
            for (const a of aging)
                lines.push(`- [${a.memory.id}] ${a.memory.title} (${a.age} days)`);
            if (aging.length > 0) {
                lines.push("", "For aging memories: check whether they still hold. If yes, propose a refresh with memory_update; if not, memory_delete with a reason.");
            }
            if (include_retired) {
                lines.push("", `## Retired memories (${retired.length})`);
                if (retired.length === 0)
                    lines.push("None.");
                for (const m of retired)
                    lines.push(`- [${m.id}] ${m.title}${m.retiredReason ? ` (${m.retiredReason})` : ""}`);
            }
            return { title: `Memory review (${active.length} active)`, output: lines.join("\n") };
        },
    });
    // ── memory_publish ────────────────────────────────────────────────────────
    const memory_publish = tool({
        description: `Publish staged memory proposals as pull requests. Call it once after you finish proposing (memory_propose / memory_update / memory_delete), or when memory_review shows pending proposals.

Safe to call without asking the user: it runs the memory bot in a throwaway git worktree, so the user's checkout, branch and uncommitted files are never touched, and it only opens PRs. The human merge is the approval gate; nothing becomes an active memory until a person merges. It takes no arguments and cannot run arbitrary git commands.

Returns the opened PR URLs. Proposals whose push or PR step failed stay staged and are retried on the next call.`,
        args: {},
        async execute(_args, context) {
            try {
                const lines = [];
                const res = await processStagingOnce(context.directory, { log: (l) => lines.push(l) });
                await logger.info("memory_publish", `promoted=${res.promoted} skipped=${res.skipped} failed=${res.failed}`);
                if (res.busy)
                    return { title: "Memory publish busy", output: "Another memory bot run is in progress. Try again shortly." };
                if (res.promoted + res.skipped + res.failed === 0) {
                    return { title: "Memory publish", output: "No staged proposals." };
                }
                const out = [`Opened ${res.promoted} PR${res.promoted === 1 ? "" : "s"}; skipped ${res.skipped}; failed ${res.failed}.`];
                if (res.prs.length)
                    out.push("", ...res.prs.map((u) => `- ${u}`));
                if (lines.length)
                    out.push("", "Log:", ...lines.map((l) => `  ${l}`));
                return { title: `Memory published (${res.promoted})`, output: out.join("\n") };
            }
            catch (err) {
                await logger.error("memory_publish", err);
                return { title: "Memory publish failed", output: `Could not publish: ${err instanceof Error ? err.message : String(err)}` };
            }
        },
    });
    return { memory_propose, memory_update, memory_delete, memory_read, memory_review, memory_publish };
}
function formatMemory(m) {
    const tags = m.tags && m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
    const lines = [`### [${m.id}]${tags} ${m.title}`];
    const meta = [m.approvedAt ? `approved ${m.approvedAt}` : ""].filter(Boolean);
    if (meta.length)
        lines.push(meta.join(" | "));
    lines.push(m.body, "");
    return lines;
}
//# sourceMappingURL=tools.js.map