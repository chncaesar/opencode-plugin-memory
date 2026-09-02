export type MemoryPolicyExample = {
  signal: "correction" | "confirmation" | "temporary" | "task-local"
  user: string
  decision: "save" | "skip"
  guidance: string
}

/**
 * Few-shot examples for the memory-writing policy. Keeping these structured
 * makes the intended decisions testable without adding a heuristic classifier
 * or a second LLM pipeline.
 */
export const MEMORY_POLICY_EXAMPLES: readonly MemoryPolicyExample[] = [
  {
    signal: "correction",
    user: "Use plain language. Do not say 'magic number' or 'enum' without explaining what you mean.",
    decision: "save",
    guidance: "call memory_add with tags [feedback, communication]",
  },
  {
    signal: "correction",
    user: "Stop summarizing the diff at the end; I can read it.",
    decision: "save",
    guidance: "call memory_add with tags [feedback, communication]",
  },
  {
    signal: "confirmation",
    user: "This explanation style works well for me. Keep using it.",
    decision: "save",
    guidance: "call memory_add with tags [feedback, communication]",
  },
  {
    signal: "confirmation",
    user: "That is exactly the level of detail I want—keep explaining it that way.",
    decision: "save",
    guidance: "call memory_add with tags [feedback, communication]",
  },
  {
    signal: "temporary",
    user: "For this task, do not run the tests.",
    decision: "skip",
    guidance: "current-task instruction, not durable memory",
  },
  {
    signal: "temporary",
    user: "For this answer only, skip the explanation.",
    decision: "skip",
    guidance: "explicitly limited to the current answer",
  },
  {
    signal: "task-local",
    user: "Do not implement this field as an enum.",
    decision: "skip",
    guidance: "task-local implementation requirement unless stated as a project-wide convention",
  },
] as const

const EXAMPLE_LINES = MEMORY_POLICY_EXAMPLES.map(
  (example) =>
    `- User: "${example.user}" -> ${example.decision === "save" ? "SAVE" : "DO NOT SAVE"}: ${example.guidance}.`,
)

/**
 * The complete policy injected on every request and repeated in the
 * memory_add tool description. It deliberately makes unscoped user feedback
 * default-to-save while preserving explicit temporary and task-local limits.
 */
export const MEMORY_WRITE_POLICY = [
  "## When to write project memory",
  "",
  "Before responding to each user message, check whether it contains knowledge that would improve a future conversation in this project.",
  "",
  "Save durable project knowledge when:",
  "- The user explicitly says \"remember this\", \"save this\", or similar.",
  "- You discover a reusable coding rule or project convention.",
  "- You fix a recurring bug pattern whose lesson should persist.",
  "- You learn project-specific context that would otherwise be rediscovered repeatedly.",
  "",
  "User feedback is a high-priority memory signal:",
  "- When the user corrects how you communicate, reason, edit, test, or collaborate, treat the correction as durable by default.",
  "- When the user confirms that a non-obvious approach worked well and wants it repeated, treat that confirmation as durable feedback.",
  "- Do not wait for the user to say \"remember this\" or \"save this\". An unscoped correction or preference applies to future conversations by default.",
  "- Save new durable feedback with memory_add in the same turn. Use specific content and appropriate tags such as feedback and communication.",
  "- In feedback content, state the rule or preference and when to apply it; include the user's reason when one is provided.",
  "- If a related memory may already exist, use memory_read and memory_update instead of creating a duplicate.",
  "",
  "Do not save instructions explicitly limited to the current answer, task, file, or one-time situation. A task-local implementation request is not automatically a reusable preference or project convention. Also do not save information already in AGENTS.md or project documentation, or obvious general programming knowledge.",
  "",
  "Examples:",
  ...EXAMPLE_LINES,
].join("\n")
