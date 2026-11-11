export type MemoryPolicyExample = {
    /**
     * "correction"     — user corrects LLM behavior (no explicit "remember" needed)
     * "confirmation"   — user confirms a non-obvious approach worked
     * "llm-discovery"  — LLM itself discovers something worth persisting (no user cue)
     * "temporary"      — explicitly scoped to current task/answer, must NOT save
     * "task-local"     — implementation detail that only applies to one task
     */
    signal: "correction" | "confirmation" | "llm-discovery" | "temporary" | "task-local";
    /** What the user said, or what the LLM encountered/discovered (for llm-discovery). */
    cue: string;
    decision: "save" | "skip";
    guidance: string;
};
/**
 * Few-shot examples for the memory-writing policy.
 *
 * Two categories of triggers are intentional:
 * 1. User-driven (correction, confirmation) — the user speaks and the LLM
 *    infers a durable rule without waiting for "remember this".
 * 2. LLM-driven (llm-discovery) — the LLM itself uncovers a non-obvious fact
 *    (a technical gotcha, a project convention, an architecture change) that
 *    a future session would need to rediscover from scratch. No user cue required.
 *
 * Keeping examples structured makes the intended decisions testable without
 * adding a heuristic classifier or a second LLM pipeline.
 */
export declare const MEMORY_POLICY_EXAMPLES: readonly MemoryPolicyExample[];
/**
 * The complete policy injected on every request and repeated in the
 * memory_propose tool description.
 *
 * The model is PR-gated: it only ever PROPOSES memories by writing a local
 * file. A bot opens a PR and a human merges it; only merged (active) memories
 * are valid and injected into context.
 */
export declare const MEMORY_WRITE_POLICY: string;
//# sourceMappingURL=prompt.d.ts.map