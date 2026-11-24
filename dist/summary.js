import { activeDir, listActiveMemoriesForIndex } from "./storage.js";
import { MEMORY_WRITE_POLICY } from "./prompt.js";
import { globalProblemPrompt } from "./stores.js";
const MEMORY_SYSTEM_INTRO = [
    "<!-- opencode-plugin-memory: PR-gated memory system (global + project) -->",
    "",
    "You have a PR-gated memory system with two stores: GLOBAL (your own knowledge, injected in every repository) and PROJECT (knowledge that holds for this repository only, shared with whoever has it). You only PROPOSE entries; a human approves each one by merging a pull request before it becomes active.",
    "Default to GLOBAL: most durable knowledge — tool and API behaviour, infrastructure, preferences, review rules — holds everywhere. Use PROJECT only when the rule would be wrong, or pointless, in a different repository.",
].join("\n");
/**
 * Shown instead of a store's index when that store could not be read at all.
 * Deliberately says nothing about the underlying cause: a filesystem message in
 * the system prompt is noise to the model and can leak machine paths.
 */
const INDEX_UNAVAILABLE = "(memory index unavailable this turn — the store could not be read; continue without it)";
/**
 * One `[mem-XXXX] Title` line per memory, ordered by id so the prompt is stable
 * across runs. Titles and ids only: full bodies stay on disk and load lazily
 * through `memory_read`.
 */
export function buildIndexLines(memories) {
    return [...memories]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((m) => `[${m.id}] ${m.title}`);
}
/** Characters used by the first `count` lines, including the newlines between them. */
function costOf(lines, count) {
    let n = 0;
    for (let i = 0; i < count; i++)
        n += lines[i].length + (i > 0 ? 1 : 0);
    return n;
}
/** How many leading lines fit in `budget` characters. */
function fitCount(lines, budget) {
    let cost = 0;
    for (let i = 0; i < lines.length; i++) {
        const add = lines[i].length + (i > 0 ? 1 : 0);
        if (cost + add > budget)
            return i;
        cost += add;
    }
    return lines.length;
}
function truncationNotice(total, shown) {
    return `… (${total} active memories; showing ${shown} — use memory_read for the full list)`;
}
function renderLines(lines, budget) {
    const fits = fitCount(lines, budget);
    if (fits === lines.length)
        return { text: lines.join("\n"), used: costOf(lines, lines.length) };
    // Reserve room for the notice. Its digit count can change once `shown`
    // shrinks, so measure with the conservative (larger) estimate and accept a
    // one-character difference.
    const notice = truncationNotice(lines.length, fits);
    const shown = fitCount(lines, Math.max(0, budget - notice.length - 1));
    const finalNotice = truncationNotice(lines.length, shown);
    const kept = lines.slice(0, shown);
    const text = kept.length > 0 ? `${kept.join("\n")}\n${finalNotice}` : finalNotice;
    return { text, used: costOf(lines, shown) + finalNotice.length + (kept.length > 0 ? 1 : 0) };
}
function renderBody(listing, lines, budget) {
    if (listing.unavailable)
        return { text: INDEX_UNAVAILABLE, used: 0 };
    if (lines.length === 0)
        return { text: "(no active memories)", used: 0 };
    const rendered = renderLines(lines, budget);
    if (listing.omitted <= 0)
        return rendered;
    const suffix = `\n… (${listing.omitted} memory file${listing.omitted === 1 ? "" : "s"} could not be read and ${listing.omitted === 1 ? "is" : "are"} omitted from this index)`;
    return { text: rendered.text + suffix, used: rendered.used };
}
/**
 * Build the block injected into every system prompt: the introduction, the
 * global index, the project index, and the writing policy.
 *
 * Budget: `maxChars` is shared. The project store keeps at least
 * `1 - share` of it reserved, so a large global store cannot push project
 * entries out of the prompt entirely; budget the project store does not need
 * is available to the global store, and vice versa. A truncated section says so
 * and points at `memory_read`.
 */
export function buildSystemPrompt(input, maxChars, share) {
    const projectLines = input.project.unavailable ? [] : buildIndexLines(input.project.memories);
    const globalAvailable = input.global !== undefined && !input.global.unavailable;
    const globalLines = globalAvailable ? buildIndexLines(input.global.memories) : [];
    const reserve = Math.ceil(maxChars * (1 - share));
    let globalPart;
    let projectBudget = maxChars;
    if (!input.global) {
        globalPart = { text: input.globalNotice ?? "(not configured)", used: 0 };
    }
    else if (input.global.unavailable) {
        globalPart = { text: INDEX_UNAVAILABLE, used: 0 };
    }
    else {
        const globalBudget = Math.max(0, maxChars - Math.min(costOf(projectLines, projectLines.length), reserve));
        globalPart = renderBody(input.global, globalLines, globalBudget);
        projectBudget = Math.max(0, maxChars - globalPart.used);
    }
    const projectPart = renderBody(input.project, projectLines, projectBudget);
    return [
        MEMORY_SYSTEM_INTRO,
        "",
        "Global memory index:",
        globalPart.text,
        "",
        "Project memory index (this repository):",
        projectPart.text,
        MEMORY_WRITE_POLICY,
        "",
    ].join("\n\n");
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
function causeCode(err) {
    return err instanceof Error && "code" in err && typeof err.code === "string"
        ? err.code
        : "error";
}
/** Tolerant read of one store for the prompt: never throws. */
async function readListing(store, onProblems) {
    try {
        const listing = await listActiveMemoriesForIndex(store.root);
        await reportProblems(onProblems, listing.problems);
        return {
            scope: store.scope,
            memories: listing.memories,
            omitted: listing.problems.length,
            unavailable: listing.folderUnreadable,
        };
    }
    catch (err) {
        // Defensive: the tolerant reader is written not to throw.
        await reportProblems(onProblems, [{ file: activeDir(store.root), code: causeCode(err) }]);
        return { scope: store.scope, memories: [], omitted: 0, unavailable: true };
    }
}
/**
 * Prompt block for a session, derived from both stores on every call.
 *
 * Reading is tolerant by design: a normal conversation must not fail because a
 * store is unreadable, one entry file is corrupt, or a folder is a file.
 * Unreadable entries are skipped and reported through `onProblems`; a store
 * that cannot be listed falls back to an unavailable notice. Raw filesystem
 * errors never reach the prompt.
 */
export async function loadPromptBlock(stores, maxChars, share, onProblems) {
    const project = await readListing(stores.project, onProblems);
    const global = stores.global ? await readListing(stores.global, onProblems) : undefined;
    const input = {
        project,
        ...(global ? { global } : {}),
        ...(stores.globalProblem ? { globalNotice: globalProblemPrompt(stores.globalProblem) } : {}),
    };
    return buildSystemPrompt(input, maxChars, share);
}
//# sourceMappingURL=summary.js.map