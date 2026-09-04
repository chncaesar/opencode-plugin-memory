export type MemoryPolicyExample = {
  /**
   * "correction"     — user corrects LLM behavior (no explicit "remember" needed)
   * "confirmation"   — user confirms a non-obvious approach worked
   * "llm-discovery"  — LLM itself discovers something worth persisting (no user cue)
   * "temporary"      — explicitly scoped to current task/answer, must NOT save
   * "task-local"     — implementation detail that only applies to one task
   */
  signal: "correction" | "confirmation" | "llm-discovery" | "temporary" | "task-local"
  /** What the user said, or what the LLM encountered/discovered (for llm-discovery). */
  cue: string
  decision: "save" | "skip"
  guidance: string
}

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
export const MEMORY_POLICY_EXAMPLES: readonly MemoryPolicyExample[] = [
  // ── User-driven: correction ──────────────────────────────────────────────
  {
    signal: "correction",
    cue: "Use plain language. Do not say 'magic number' or 'enum' without explaining what you mean.",
    decision: "save",
    guidance: "call memory_add with tags [feedback, communication]",
  },
  {
    signal: "correction",
    cue: "Stop summarizing the diff at the end; I can read it.",
    decision: "save",
    guidance: "call memory_add with tags [feedback, communication]",
  },

  // ── User-driven: confirmation ────────────────────────────────────────────
  {
    signal: "confirmation",
    cue: "This explanation style works well for me. Keep using it.",
    decision: "save",
    guidance: "call memory_add with tags [feedback, communication]",
  },
  {
    signal: "confirmation",
    cue: "That is exactly the level of detail I want—keep explaining it that way.",
    decision: "save",
    guidance: "call memory_add with tags [feedback, communication]",
  },

  // ── LLM-driven: technical gotcha discovered during work ──────────────────
  {
    signal: "llm-discovery",
    cue: "I tried setting metabase_field.visibility_type='hidden' to hide columns from drill-through, but after testing I confirmed hidden fields still appear. Only 'details-only' is filtered out by the frontend.",
    decision: "save",
    guidance: "call memory_add immediately after confirming the gotcha, with tags [metabase, drill-through]. Do not wait for the user to say 'remember this'.",
  },
  {
    signal: "llm-discovery",
    cue: "I changed the deployment from 'git archive HEAD | ssh tar' to a git-pull flow. The old approach silently deployed uncommitted working-tree changes — a correctness hazard.",
    decision: "save",
    guidance: "call memory_add after completing the architecture change, with tags [deployment, workflow]. The rule ('deploy only committed code via git pull') is durable across all future sessions.",
  },
  {
    signal: "llm-discovery",
    cue: "I verified that in this project the Kingdee field F_XTR_Text (caption '版本') stores the product model (e.g. APT32F102C) and is the canonical product dimension for outsource order analytics.",
    decision: "save",
    guidance: "call memory_add when discovering project-specific domain facts that a future session would spend time re-investigating, with tags [domain, kingdee].",
  },
  {
    signal: "llm-discovery",
    cue: "The user pushed back on my direct server-side sed edit and explained that all production changes must go through git. I was wrong to bypass version control.",
    decision: "save",
    guidance: "call memory_add when the user rejects an approach and states a project rule, even without the word 'remember'. Tag with [workflow, ops].",
  },
  {
    signal: "llm-discovery",
    cue: "I noticed that Metabase MBQL drill-through always exposes all underlying table columns. Hidden (visibility_type='hidden') does not suppress them; 'details-only' does.",
    decision: "save",
    guidance: "the 'if a future session wouldn't know this and would waste time' test passes — call memory_add with tags [metabase, architecture].",
  },

  // ── Temporary / task-local: must NOT save ───────────────────────────────
  {
    signal: "temporary",
    cue: "For this task, do not run the tests.",
    decision: "skip",
    guidance: "current-task instruction, not durable memory",
  },
  {
    signal: "temporary",
    cue: "For this answer only, skip the explanation.",
    decision: "skip",
    guidance: "explicitly limited to the current answer",
  },
  {
    signal: "task-local",
    cue: "Do not implement this field as an enum.",
    decision: "skip",
    guidance: "task-local implementation requirement unless stated as a project-wide convention",
  },
] as const

const EXAMPLE_LINES = MEMORY_POLICY_EXAMPLES.map((example) => {
  const speaker = example.signal === "llm-discovery" ? "LLM discovers" : "User"
  const verdict = example.decision === "save" ? "SAVE" : "DO NOT SAVE"
  return `- ${speaker}: "${example.cue}" -> ${verdict}: ${example.guidance}.`
})

/**
 * The complete policy injected on every request and repeated in the
 * memory_add tool description.
 *
 * Two modes of triggering are intentional:
 * - Reactive  — user feedback/correction → save without waiting for "remember this"
 * - Proactive — LLM discovers a non-obvious fact → save immediately, no user cue needed
 */
export const MEMORY_WRITE_POLICY = [
  "## When to write project memory",
  "",
  "Before responding to each user message, check whether the current turn contains knowledge that would improve a future conversation in this project.",
  "",
  "Save durable project knowledge when:",
  "- The user explicitly says \"remember this\", \"save this\", or similar.",
  "- You discover a reusable coding rule or project convention.",
  "- You fix a recurring bug pattern whose lesson should persist.",
  "- You learn project-specific context (domain rules, API quirks, infrastructure facts) that would otherwise be rediscovered from scratch in a future session.",
  "- You complete an architecture or workflow change that defines a new norm (e.g. a new deployment procedure).",
  "",
  "User feedback is a high-priority memory signal:",
  "- When the user corrects how you communicate, reason, edit, test, or collaborate, treat the correction as durable by default.",
  "- When the user confirms that a non-obvious approach worked well and wants it repeated, treat that as durable feedback.",
  "- Do not wait for the user to say \"remember this\" or \"save this\". An unscoped correction or preference applies to future conversations by default.",
  "- Save new durable feedback with memory_add in the same turn. Use specific content and appropriate tags such as feedback and communication.",
  "- In feedback content, state the rule or preference and when to apply it; include the user's reason when one is provided.",
  "- If a related memory may already exist, use memory_read and memory_update instead of creating a duplicate.",
  "",
  "LLM-proactive memory: save without any user cue when you discover:",
  "- A technical gotcha or non-obvious API behavior confirmed during this session (e.g. a library limitation, a wrong assumption corrected by evidence).",
  "- A project-specific domain fact (business rule, field mapping, naming convention) that took investigation to establish.",
  "- A completed workflow or architecture change that all future sessions should follow.",
  "- Any lesson where the 'would a future session waste time rediscovering this?' test is YES.",
  "",
  "Do not save instructions explicitly limited to the current answer, task, file, or one-time situation. A task-local implementation request is not automatically a reusable preference or project convention. Also do not save information already in AGENTS.md or project documentation, or obvious general programming knowledge.",
  "",
  "## Granularity and title-content coherence",
  "",
  "Each memory entry must be a single, focused fact or rule. Do not bundle unrelated behaviors into one entry just because they involve the same tool or domain.",
  "",
  "**Title must summarize the full content.** A future LLM reading only the title in the summary should be able to tell whether to call memory_read for that entry. If the title does not cover part of the content, that part will be silently ignored — the LLM will never load it.",
  "",
  "Rules:",
  "- One entry = one distinct behavioral rule, gotcha, or fact.",
  "- If your content contains two independent behaviors (e.g. 'tooltip must use business language' AND 'drill-through requires details-only'), split them into two entries with separate titles.",
  "- The title must name the specific behavior, not just the domain. Bad: 'Metabase display rules'. Good: 'Metabase drill-through: use details-only to hide columns, not hidden'.",
  "- If you cannot write a title that covers all the content without exceeding 120 chars, that is a signal to split the entry.",
  "",
  "Counter-example (do NOT do this):",
  "- Title: 'Metabase tooltip rules'",
  "- Content: covers tooltip language rules AND drill-through visibility behavior AND display_name sync requirements",
  "- Problem: LLM only loads this entry when thinking about tooltips, so it misses the drill-through rule entirely.",
  "",
  "Correct split:",
  "- Entry A — Title: 'Metabase card description (tooltip): pure business Chinese, no field names' — content: tooltip/description rules only",
  "- Entry B — Title: 'Metabase drill-through: details-only hides columns, hidden does not' — content: drill-through visibility behavior only",
  "- Entry C — Title: 'Metabase MBQL cards: set display_name to Chinese before going live' — content: display_name sync requirement",
  "",
  "Examples:",
  ...EXAMPLE_LINES,
].join("\n")
