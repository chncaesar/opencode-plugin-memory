import fs from "fs/promises";
import { summaryFilePath, memoryDir } from "./storage.js";
const SUMMARY_HEADER = `<!-- opencode-plugin-memory: project memory summary -->
<!-- This file is auto-generated — edit MEMORY.md instead -->`;
// Injected into the system prompt when a project has no memories yet.
// This is the "cold start" case: without it, a fresh project gives the LLM
// no signal that a memory system exists at all.
const EMPTY_SYSTEM_PROMPT = [
    "<!-- opencode-plugin-memory: project memory system -->",
    "",
    "You have a persistent, project-scoped memory system (tools: memory_add, memory_update, memory_delete, memory_read).",
    "No memories are stored for this project yet.",
    "",
    "Save durable knowledge with memory_add when:",
    '- the user says "remember this" / "记住" / "save this"',
    "- you discover a reusable coding rule or project convention",
    "- you fix a recurring bug pattern whose lesson should persist",
    "- you learn a project-specific fact you would otherwise re-discover",
    "- the user corrects your behavior and the correction should persist",
    "",
].join("\n");
// Appended to the summary when memories exist, so the LLM keeps maintaining
// the store rather than treating it as a read-only list.
const MAINTAIN_NUDGE = "Maintain this memory: call memory_add when you learn durable project knowledge — " +
    "a reusable rule/convention, a recurring bug lesson, a project-specific fact, " +
    "or a user behavior correction that should persist.";
/**
 * Build the text content for memory_summary.md from active entries,
 * truncated to at most maxChars characters.
 *
 * The summary is intentionally compact so it can be injected into every
 * system prompt with minimal token cost.  Entries are ordered newest-first
 * (by "added" date) so the most recent knowledge survives truncation.
 */
export function buildSummary(store, maxChars) {
    const active = store.entries
        .filter((e) => !e.archived)
        .sort((a, b) => (b.added > a.added ? 1 : b.added < a.added ? -1 : 0));
    if (active.length === 0) {
        return [SUMMARY_HEADER, "", "No memories stored yet.", ""].join("\n");
    }
    const lines = [
        SUMMARY_HEADER,
        "",
        "Project memories (use memory_read for full content, memory_add/update/delete to manage):",
        "",
    ];
    for (const e of active) {
        const tags = e.tags && e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
        const line = `- [${e.id}]${tags} ${e.title}`;
        lines.push(line);
    }
    lines.push("");
    const full = lines.join("\n");
    if (full.length <= maxChars)
        return full;
    // Truncate: keep header + as many entries as fit, with a truncation notice
    const header = [
        SUMMARY_HEADER,
        "",
        "Project memories (truncated — use memory_read for full list):",
        "",
    ].join("\n");
    const notice = `\n... (${active.length} total; showing recent entries only)\n`;
    const budget = maxChars - header.length - notice.length - 2;
    const entryLines = lines.slice(4, -1); // just the "- [MEM-xxx] ..." lines
    let kept = "";
    for (const line of entryLines) {
        if (kept.length + line.length + 1 > budget)
            break;
        kept += line + "\n";
    }
    return header + kept + notice;
}
/**
 * Build the full block injected into every system prompt.
 *
 * This is what the LLM actually sees — unlike `buildSummary`, it is not just
 * a list of entries. It always carries an instruction to use the memory
 * system, and it handles the empty store case so a fresh project still learns
 * that memory tools exist (the single biggest reason memory goes unused).
 */
export function buildSystemPrompt(store, maxChars) {
    const hasActive = store.entries.some((e) => !e.archived);
    if (!hasActive)
        return EMPTY_SYSTEM_PROMPT;
    return buildSummary(store, maxChars).trimEnd() + "\n\n" + MAINTAIN_NUDGE + "\n";
}
/**
 * Write the summary file to disk, creating the directory if needed.
 */
export async function writeSummary(projectDir, store, maxChars) {
    const dir = memoryDir(projectDir);
    await fs.mkdir(dir, { recursive: true });
    const content = buildSummary(store, maxChars);
    await fs.writeFile(summaryFilePath(projectDir), content, "utf8");
}
/**
 * Read the current summary file, returning an empty string if it does not exist.
 */
export async function readSummary(projectDir) {
    try {
        return await fs.readFile(summaryFilePath(projectDir), "utf8");
    }
    catch (err) {
        if (isNodeError(err) && err.code === "ENOENT")
            return "";
        throw err;
    }
}
function isNodeError(err) {
    return err instanceof Error && "code" in err;
}
//# sourceMappingURL=summary.js.map