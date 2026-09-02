export type MemoryPolicyExample = {
    signal: "correction" | "confirmation" | "temporary" | "task-local";
    user: string;
    decision: "save" | "skip";
    guidance: string;
};
/**
 * Few-shot examples for the memory-writing policy. Keeping these structured
 * makes the intended decisions testable without adding a heuristic classifier
 * or a second LLM pipeline.
 */
export declare const MEMORY_POLICY_EXAMPLES: readonly MemoryPolicyExample[];
/**
 * The complete policy injected on every request and repeated in the
 * memory_add tool description. It deliberately makes unscoped user feedback
 * default-to-save while preserving explicit temporary and task-local limits.
 */
export declare const MEMORY_WRITE_POLICY: string;
//# sourceMappingURL=prompt.d.ts.map