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
export declare const PUBLISH_STATE_FILE = "publish-state.json";
export type PublishOutcome = "ok" | "failed";
export type PublishState = {
    /** Outcome of the last run that reached a verdict (a busy run records nothing). */
    lastOutcome?: PublishOutcome;
    /** When that verdict was recorded. */
    lastOutcomeAt?: string;
    /** Clipped reason the last run failed; absent once a later run succeeds. */
    lastError?: string;
};
/** Absolute path of the publish-state file inside a store's machine-local `.memory`. */
export declare function publishStatePath(projectDir: string): string;
/** Clip an error to one short line a prompt or a review can carry. */
export declare function clipPublishError(text: string): string;
/** Read the last publish record; `{}` when it is missing, unreadable or corrupt. */
export declare function readPublishState(projectDir: string): Promise<PublishState>;
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
export declare function writePublishState(projectDir: string, state: PublishState): Promise<void>;
/**
 * Persist a failed publish. Best effort: the caller has already failed, and a
 * broken state path must not replace the original error or outcome.
 */
export declare function recordPublishFailure(projectDir: string, reason: string, at?: Date): Promise<void>;
/**
 * Clear a recorded failure after a run that verified there is nothing left to
 * publish (everything published, or nothing staged).
 *
 * A quiet run with no recorded failure writes nothing: in `watch` mode this is
 * called on every poll, and rewriting an unchanged file would be pure churn.
 */
export declare function recordPublishSuccess(projectDir: string, at?: Date): Promise<void>;
/**
 * A short system-prompt warning while the last publish is still failed, or null.
 * Path-free: the prompt names the failing step, not where the store lives.
 */
export declare function publishWarning(directory: string): Promise<string | null>;
/** Lines for `memory_review`: how publishing last went for this store. */
export declare function describePublishStatus(directory: string): Promise<string[]>;
//# sourceMappingURL=publishState.d.ts.map