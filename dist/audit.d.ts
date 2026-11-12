import type { Memory, PluginConfig, RetiredReason } from "./types.js";
import type { Logger } from "./logging.js";
export declare const AUDIT_SYSTEM_PROMPT: string;
export declare function buildAuditPrompt(memories: Memory[]): string;
/**
 * Order entries so related ones sit next to each other (greedy nearest
 * neighbour on title/tag/body similarity, starting from the lowest id). Pure and
 * deterministic, so repeated audits of the same store batch it the same way.
 */
export declare function orderBySimilarity(memories: Memory[]): Memory[];
/**
 * Split entries into batches of at most `maxChars` prompt characters. A store
 * that fits is returned as one batch unchanged. Otherwise entries are ordered by
 * similarity, filled greedily, and each batch repeats the last `overlap` entries
 * of the previous one. An entry larger than the budget gets a batch of its own.
 * Pairs that land in different batches can still be missed; ordering and overlap
 * make that unlikely, not impossible.
 */
export declare function splitIntoBatches(memories: Memory[], maxChars: number, overlap?: number): Memory[][];
export type AuditFinding = {
    relation: "duplicate" | "refinement" | "contradiction";
    /** ID of the active memory the audit proposes retiring. */
    retire: string;
    /** For a refinement, the broader active memory that subsumes the retired one. */
    supersededBy?: string;
    reason: string;
};
/**
 * Turn a model reply into validated findings. Anything malformed or referring
 * to unknown IDs is dropped. Returns null when the reply is not a usable audit
 * result at all (so the caller can treat it as a failed run).
 */
export declare function parseAuditResponse(text: string, active: Memory[]): AuditFinding[] | null;
/** Map a finding relation onto the fixed retirement vocabulary. */
export declare function relationToReason(relation: AuditFinding["relation"]): RetiredReason;
/** Stable hash of the active memories' text (order-independent). */
export declare function activeHash(memories: Memory[]): string;
/** Sends system + user text to a model and returns the reply text. Throws on failure. */
export type ModelCall = (system: string, prompt: string) => Promise<string>;
export type AuditOutcome = "disabled" | "skipped-unchanged" | "skipped-interval" | "skipped-too-few" | "discarded-changed" | "failed" | "done";
export type AuditDeps = {
    directory: string;
    config: PluginConfig;
    logger: Logger;
    call: ModelCall;
    /** Show a short message to the user (e.g. a TUI toast). Called when a failure is new, never repeated for the same error. */
    notify?: (message: string) => Promise<void> | void;
    now?: () => Date;
    /** Bypass the minimum interval (explicit refresh). Unchanged entries are still skipped. */
    force?: boolean;
};
/**
 * Run one audit if the guards allow it. Never throws. Guards, in order:
 * enabled, at least two active entries, entries changed
 * since the last completed audit, minimum interval since the last attempt.
 *
 * On success, each finding becomes an `intent: retire` staging proposal (with
 * `superseded_by` for refinements) so the bot can open a PR for it.
 */
export declare function runAudit(deps: AuditDeps): Promise<AuditOutcome>;
/** Does a model/transport error message look like the prompt was too large for the model? */
export declare function looksLikeContextOverflow(message: string): boolean;
/** What the user can do about a failure, or null when there is no specific advice. */
export declare function auditFailureHint(message: string, config: PluginConfig): string | null;
/** Lines for `memory_review`: how the background audit last went. */
export declare function describeAuditStatus(directory: string, config: PluginConfig): Promise<string[]>;
/** The slice of the OpenCode SDK client the audit uses. */
export type AuditClient = {
    session: {
        create(options: {
            body?: {
                title?: string;
            };
            query?: {
                directory?: string;
            };
        }): Promise<{
            data?: {
                id: string;
            } | undefined;
            error?: unknown;
        }>;
        prompt(options: {
            path: {
                id: string;
            };
            query?: {
                directory?: string;
            };
            body: {
                agent?: string;
                system?: string;
                parts: Array<{
                    type: "text";
                    text: string;
                }>;
            };
        }): Promise<{
            data?: {
                info?: {
                    error?: {
                        name?: string;
                        data?: {
                            message?: string;
                        };
                    };
                };
                parts: Array<{
                    type: string;
                    text?: string;
                }>;
            } | undefined;
            error?: unknown;
        }>;
        delete(options: {
            path: {
                id: string;
            };
            query?: {
                directory?: string;
            };
        }): Promise<unknown>;
    };
};
/**
 * Build a ModelCall that runs in a throwaway session under the restricted audit
 * agent. The session is registered in `auditSessions` (so event and
 * system-prompt hooks ignore it) and always deleted afterwards.
 */
export declare function createSdkModelCall(client: AuditClient, directory: string, auditSessions: Set<string>, agentName?: string): ModelCall;
export type AuditScheduler = {
    /** Call when any session goes idle. Fire-and-forget; safe to call often. */
    onSessionIdle(sessionID: string): void;
    /** Run an audit now, bypassing the interval. Waits for an in-flight audit first. */
    runNow(): Promise<AuditOutcome>;
    /** Resolves when no audit is running (for tests). */
    settled(): Promise<void>;
};
/** Serializes audits in this process and ignores idle events from audit sessions. */
export declare function createAuditScheduler(deps: AuditDeps, auditSessions: Set<string>): AuditScheduler;
//# sourceMappingURL=audit.d.ts.map