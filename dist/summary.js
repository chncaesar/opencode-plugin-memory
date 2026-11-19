import { activeDir, listActiveMemoriesForIndex } from "./storage.js";
import { MEMORY_WRITE_POLICY } from "./prompt.js";
const MEMORY_SYSTEM_INTRO = [
    "<!-- opencode-plugin-memory: PR-gated project memory system -->",
    "",
    "You have a PR-gated, project-scoped memory system (tools: memory_propose, memory_update, memory_delete, memory_read, memory_review).",
    "You only PROPOSE memories; a human approves each one by merging a pull request before it becomes active.",
].join("\n");
/**
 * Shown instead of the index when the committed store could not be read at all.
 * Deliberately says nothing about the underlying cause: a filesystem message in
 * the system prompt is noise to the model and can leak machine paths.
 */
const INDEX_UNAVAILABLE = "(memory index unavailable this turn — the committed store could not be read; continue without it)";
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
 *
 * `options.indexUnavailable` replaces the index when the store could not be
 * listed; `options.omitted` is the number of memory files skipped because they
 * were unreadable or invalid, so the model knows the list may be incomplete.
 */
export function buildSystemPrompt(memories, maxChars, options = {}) {
    const lines = buildIndexLines(memories);
    let index;
    if (options.indexUnavailable) {
        index = INDEX_UNAVAILABLE;
    }
    else if (lines.length === 0) {
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
    const omitted = options.omitted ?? 0;
    if (!options.indexUnavailable && omitted > 0) {
        index += `\n… (${omitted} memory file${omitted === 1 ? "" : "s"} could not be read and ${omitted === 1 ? "is" : "are"} omitted from this index)`;
    }
    return [MEMORY_SYSTEM_INTRO, "", "Project memory index:", index, MEMORY_WRITE_POLICY, ""].join("\n\n");
}
async function reportProblems(reporter, problems) {
    if (problems.length === 0 || !reporter)
        return;
    try {
        await reporter(problems);
    }
    catch {
        // Diagnostics are best effort: never let reporting break the prompt.
    }
}
/**
 * Prompt block for a project, derived from its active memories on every call.
 *
 * Reading the store is tolerant by design: a normal conversation must not fail
 * because `memory/active/` is unreadable, one entry file is corrupt, or the
 * folder is a file. Unreadable entries are skipped and reported through
 * `onProblems`; when the folder itself cannot be read, the block falls back to
 * the writing policy with an index-unavailable notice. Raw filesystem errors
 * never reach the prompt.
 */
export async function loadMemoryBlock(projectDir, maxChars, onProblems) {
    let listing;
    try {
        listing = await listActiveMemoriesForIndex(projectDir);
    }
    catch (err) {
        // Defensive: the tolerant reader is written not to throw. If it ever does,
        // the prompt still renders.
        const code = err instanceof Error && "code" in err && typeof err.code === "string"
            ? err.code
            : "error";
        await reportProblems(onProblems, [{ file: activeDir(projectDir), code }]);
        return buildSystemPrompt([], maxChars, { indexUnavailable: true });
    }
    await reportProblems(onProblems, listing.problems);
    if (listing.folderUnreadable) {
        return buildSystemPrompt(listing.memories, maxChars, { indexUnavailable: true });
    }
    return buildSystemPrompt(listing.memories, maxChars, { omitted: listing.problems.length });
}
//# sourceMappingURL=summary.js.map