import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { machineDir } from "./storage.js";
/**
 * Machine-local record of the last publish run for one store.
 *
 * A publish failure is reported once, in the `memory_publish` result of the call
 * that hit it. Without a durable record the user has to have been watching that
 * exact call: the failure is gone from the next turn, while the proposals are
 * still staged and no pull request exists. So the failure is written next to the
 * store's other runtime state and read back by the system prompt (as a warning)
 * and by `memory_review` (as status) until a later run verifies otherwise.
 *
 * This is a diagnostic, never a correctness requirement: every write here is
 * best effort, a missing or corrupt file reads as "no record", and a failure to
 * record never changes the outcome of the run itself. The durable record of a
 * publish is the pull request, not this file.
 */
export const PUBLISH_STATE_FILE = "publish-state.json";
/** Longest error text kept; git/gh failures can be pages long. */
const MAX_ERROR_CHARS = 400;
/** Absolute path of the publish-state file inside a store's machine-local `.memory`. */
export function publishStatePath(projectDir) {
    return path.join(machineDir(projectDir), PUBLISH_STATE_FILE);
}
/** Classify `.memory` without following a symlink. */
async function machineDirKind(dir) {
    try {
        const stat = await fs.lstat(dir);
        return stat.isDirectory() ? "dir" : "other";
    }
    catch (err) {
        if (err.code === "ENOENT")
            return "missing";
        throw err;
    }
}
/** Clip an error to one short line a prompt or a review can carry. */
export function clipPublishError(text) {
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length <= MAX_ERROR_CHARS ? clean : `${clean.slice(0, MAX_ERROR_CHARS - 1)}…`;
}
/** Read the last publish record; `{}` when it is missing, unreadable or corrupt. */
export async function readPublishState(projectDir) {
    let text;
    try {
        text = await fs.readFile(publishStatePath(projectDir), "utf8");
    }
    catch {
        return {};
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return {};
    }
    if (!parsed || typeof parsed !== "object")
        return {};
    const o = parsed;
    const state = {};
    if (o["lastOutcome"] === "ok" || o["lastOutcome"] === "failed")
        state.lastOutcome = o["lastOutcome"];
    if (typeof o["lastOutcomeAt"] === "string")
        state.lastOutcomeAt = o["lastOutcomeAt"];
    if (typeof o["lastError"] === "string")
        state.lastError = o["lastError"];
    return state;
}
/**
 * Write the record atomically: a complete temporary file is renamed into place,
 * so a concurrent reader sees either the previous record or the new one, never
 * half-written JSON.
 *
 * `.memory` is untrusted input here: a publish may be failing precisely because
 * `.memory` is a symlink or not a directory, and the record of that failure must
 * not be written through it. A pre-existing `.memory` must be a real directory;
 * an absent one is created.
 */
export async function writePublishState(projectDir, state) {
    const dir = machineDir(projectDir);
    const refuse = () => new Error(".memory is not a real directory; refusing to write the publish record");
    if ((await machineDirKind(dir)) === "other")
        throw refuse();
    await fs.mkdir(dir, { recursive: true });
    // mkdir does not follow a symlink at the leaf, but a race could still swap one in.
    if ((await machineDirKind(dir)) !== "dir")
        throw refuse();
    const target = publishStatePath(projectDir);
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
        await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        await fs.rename(tmp, target);
    }
    catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
    }
}
/**
 * Persist a failed publish. Best effort: the caller has already failed, and a
 * broken state path must not replace the original error or outcome.
 */
export async function recordPublishFailure(projectDir, reason, at = new Date()) {
    await writePublishState(projectDir, {
        lastOutcome: "failed",
        lastOutcomeAt: at.toISOString(),
        lastError: clipPublishError(reason),
    }).catch(() => undefined);
}
/**
 * Clear a recorded failure after a run that verified there is nothing left to
 * publish (everything published, or nothing staged).
 *
 * A quiet run with no recorded failure writes nothing: in `watch` mode this is
 * called on every poll, and rewriting an unchanged file would be pure churn.
 */
export async function recordPublishSuccess(projectDir, at = new Date()) {
    const state = await readPublishState(projectDir);
    if (state.lastOutcome !== "failed")
        return;
    await writePublishState(projectDir, {
        lastOutcome: "ok",
        lastOutcomeAt: at.toISOString(),
    }).catch(() => undefined);
}
/**
 * A short system-prompt warning while the last publish is still failed, or null.
 * Path-free: the prompt names the failing step, not where the store lives.
 */
export async function publishWarning(directory) {
    const state = await readPublishState(directory);
    if (state.lastOutcome !== "failed")
        return null;
    return [
        "[memory plugin warning] The last memory publish FAILED" +
            (state.lastOutcomeAt ? ` (${state.lastOutcomeAt})` : "") +
            `: ${state.lastError ?? "(no message)"}`,
        "That run did not open a pull request for every proposal (some may already have been opened).",
        "Explain this to the user once, in plain words, then retry memory_publish after the cause is fixed.",
    ].join("\n");
}
/** Lines for `memory_review`: how publishing last went for this store. */
export async function describePublishStatus(directory) {
    const state = await readPublishState(directory);
    if (!state.lastOutcome)
        return ["No publish recorded yet for this store."];
    const when = state.lastOutcomeAt ?? "(unknown time)";
    if (state.lastOutcome === "ok")
        return [`Last publish: ${when} — ok`];
    return [
        `Last publish: ${when} — FAILED`,
        `Error: ${state.lastError ?? "(no message)"}`,
        "That run did not open a pull request for every proposal. Fix the cause, then call memory_publish to retry.",
    ];
}
//# sourceMappingURL=publishState.js.map