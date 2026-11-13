import { listActiveMemories } from "./storage.js";
import { MEMORY_WRITE_POLICY } from "./prompt.js";
const MEMORY_SYSTEM_INTRO = [
    "<!-- opencode-plugin-memory: PR-gated project memory system -->",
    "",
    "You have a PR-gated, project-scoped memory system (tools: memory_propose, memory_update, memory_delete, memory_read, memory_review).",
    "You only PROPOSE memories; a human approves each one by merging a pull request before it becomes active.",
].join("\n");
/**
 * Build the index shown to the model: one `[mem-XXXX] Title` line per active
 * memory, ordered by id so the prompt is stable across runs. The index is
 * always derived from `memory/active/`; nothing is read from or written to a
 * prebuilt index file.
 */
export function buildIndexLines(memories) {
    return [...memories]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((m) => `[${m.id}] ${m.title}`);
}
/**
 * Build the block injected into every system prompt: the memory-system
 * introduction, the index (titles and ids only, never full bodies), and the
 * complete writing policy. Full bodies stay on disk and load lazily through
 * `memory_read`, so a large store costs only one line per memory per turn.
 */
export function buildSystemPrompt(memories, maxChars) {
    const lines = buildIndexLines(memories);
    let index;
    if (lines.length === 0) {
        index = "(no active memories — propose your first with memory_propose)";
    }
    else {
        let body = lines.join("\n");
        if (body.length > maxChars) {
            const notice = `\n… (${lines.length} active memories; showing a subset — use memory_read for the full list)`;
            const kept = [];
            let budget = maxChars - notice.length;
            for (const line of lines) {
                const cost = line.length + (kept.length > 0 ? 1 : 0);
                if (cost > budget)
                    break;
                kept.push(line);
                budget -= cost;
            }
            body = kept.join("\n") + notice;
        }
        index = body;
    }
    return [MEMORY_SYSTEM_INTRO, "", "Project memory index:", index, MEMORY_WRITE_POLICY, ""].join("\n\n");
}
/** Prompt block for a project, derived from its active memories on every call. */
export async function loadMemoryBlock(projectDir, maxChars) {
    return buildSystemPrompt(await listActiveMemories(projectDir), maxChars);
}
//# sourceMappingURL=summary.js.map