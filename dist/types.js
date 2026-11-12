/**
 * The fixed vocabulary of retirement reasons. A retired memory carries one of
 * these in its frontmatter so the reason is machine-checkable.
 */
export const RETIRED_REASONS = ["wrong", "stale", "useless", "superseded", "duplicate"];
/**
 * The intent carried by a staged proposal file, telling the bot what to do.
 * - `propose` — a new memory (optionally carrying `supersedes`).
 * - `retire` — remove an existing active memory (names the target `id`).
 */
export const INTENTS = ["propose", "retire"];
export const DEFAULT_CONFIG = {
    maxSummaryChars: 10000,
    enableLog: true,
    staleDays: 90,
    backgroundAudit: true,
    auditIntervalMinutes: 1,
    auditBatchChars: 400_000,
};
//# sourceMappingURL=types.js.map