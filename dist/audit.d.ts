import type { MemoryEntry, MemoryStore, PluginConfig } from "./types.js";
import type { Logger } from "./logging.js";
import { type Finding } from "./review.js";
export declare const AUDIT_SYSTEM_PROMPT: string;
export declare function buildAuditPrompt(entries: MemoryEntry[]): string;
/**
 * Turn a model reply into validated findings. Anything malformed or referring
 * to unknown/archived IDs is dropped. Returns null when the reply is not a
 * usable audit result at all (so the caller can treat it as a failed run).
 */
export declare function parseAuditResponse(text: string, store: MemoryStore): Finding[] | null;
/** Sends system + user text to a model and returns the reply text. Throws on failure. */
export type ModelCall = (system: string, prompt: string) => Promise<string>;
export type AuditOutcome = "disabled" | "skipped-unchanged" | "skipped-interval" | "skipped-too-few" | "skipped-too-many" | "discarded-changed" | "failed" | "done";
export type AuditDeps = {
    directory: string;
    config: PluginConfig;
    logger: Logger;
    call: ModelCall;
    now?: () => Date;
    /** Bypass the minimum interval (explicit refresh). Unchanged entries are still skipped. */
    force?: boolean;
};
/**
 * Run one audit if the guards allow it. Never throws. Guards, in order:
 * enabled, at least two active entries, not too many entries, entries changed
 * since the last completed audit, minimum interval since the last attempt.
 */
export declare function runAudit(deps: AuditDeps): Promise<AuditOutcome>;
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