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
export const MEMORY_POLICY_EXAMPLES = [
    // ── User-driven: correction ──────────────────────────────────────────────
    {
        signal: "correction",
        cue: "Use plain language. Do not say 'magic number' or 'enum' without explaining what you mean.",
        decision: "save",
        guidance: "call memory_propose with tags [feedback, communication]",
    },
    {
        signal: "correction",
        cue: "Stop summarizing the diff at the end; I can read it.",
        decision: "save",
        guidance: "call memory_propose with tags [feedback, communication]",
    },
    // ── User-driven: confirmation ────────────────────────────────────────────
    {
        signal: "confirmation",
        cue: "This explanation style works well for me. Keep using it.",
        decision: "save",
        guidance: "call memory_propose with tags [feedback, communication]",
    },
    {
        signal: "confirmation",
        cue: "That is exactly the level of detail I want—keep explaining it that way.",
        decision: "save",
        guidance: "call memory_propose with tags [feedback, communication]",
    },
    // ── LLM-driven: technical gotcha discovered during work ──────────────────
    {
        signal: "llm-discovery",
        cue: "I tried setting metabase_field.visibility_type='hidden' to hide columns from drill-through, but after testing I confirmed hidden fields still appear. Only 'details-only' is filtered out by the frontend.",
        decision: "save",
        guidance: "call memory_propose immediately after confirming the gotcha, with tags [metabase, drill-through]. Do not wait for the user to say 'remember this'.",
    },
    {
        signal: "llm-discovery",
        cue: "I changed the deployment from 'git archive HEAD | ssh tar' to a git-pull flow. The old approach silently deployed uncommitted working-tree changes — a correctness hazard.",
        decision: "save",
        guidance: "call memory_propose after completing the architecture change, with tags [deployment, workflow]. The rule ('deploy only committed code via git pull') is durable across all future sessions.",
    },
    {
        signal: "llm-discovery",
        cue: "I verified that in this project the Kingdee field F_XTR_Text (caption '版本') stores the product model (e.g. APT32F102C) and is the canonical product dimension for outsource order analytics.",
        decision: "save",
        guidance: "call memory_propose when discovering project-specific domain facts that a future session would spend time re-investigating, with tags [domain, kingdee].",
    },
    {
        signal: "llm-discovery",
        cue: "The user pushed back on my direct server-side sed edit and explained that all production changes must go through git. I was wrong to bypass version control.",
        decision: "save",
        guidance: "call memory_propose when the user rejects an approach and states a project rule, even without the word 'remember'. Tag with [workflow, ops].",
    },
    {
        signal: "llm-discovery",
        cue: "I noticed that Metabase MBQL drill-through always exposes all underlying table columns. Hidden (visibility_type='hidden') does not suppress them; 'details-only' does.",
        decision: "save",
        guidance: "the 'if a future session wouldn't know this and would waste time' test passes — call memory_propose with tags [metabase, architecture].",
    },
    // ── LLM-driven: design lesson behind a bug fix ───────────────────────────
    {
        signal: "llm-discovery",
        cue: "I fixed a bug where an inventory table lost about half its rows because the primary key left out the lot number. The incident is fixed, but the cause is a modeling mistake: the key did not match the true data grain.",
        decision: "save",
        guidance: "call memory_propose with the generalized rule (define the primary key as the true data grain before modeling or extracting any table, otherwise rows are silently merged and totals are wrong), tags [data-modeling, granularity]. Lead with the rule and keep the incident as a one-line example. Do not title the memory after the single table that broke",
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
        cue: "I checked production and schema_migrations is at version 110 with dirty=false.",
        decision: "skip",
        guidance: "a current state that one read-only query returns at any time; it goes stale and the query is more accurate than a memory",
    },
    {
        signal: "task-local",
        cue: "Do not implement this field as an enum.",
        decision: "skip",
        guidance: "task-local implementation requirement unless stated as a project-wide convention",
    },
];
const EXAMPLE_LINES = MEMORY_POLICY_EXAMPLES.map((example) => {
    const speaker = example.signal === "llm-discovery" ? "LLM discovers" : "User";
    const verdict = example.decision === "save" ? "SAVE" : "DO NOT SAVE";
    return `- ${speaker}: "${example.cue}" -> ${verdict}: ${example.guidance}.`;
});
/**
 * The complete policy injected on every request and repeated in the
 * memory_propose tool description.
 *
 * The model is PR-gated: it only ever PROPOSES memories by writing a local
 * file. A bot opens a PR and a human merges it; only merged (active) memories
 * are valid and injected into context.
 */
export const MEMORY_WRITE_POLICY = [
    "## When to propose project memory",
    "",
    "You have a PR-gated, project-scoped memory system. You do NOT write memory directly — you PROPOSE it. A proposal is only a suggestion; it becomes a real memory only after a human reviews and merges it via a pull request.",
    "",
    "Before responding to each user message, check whether the current turn contains knowledge that would improve a future conversation in this project.",
    "",
    "Propose durable project knowledge when:",
    "- The user explicitly says \"remember this\", \"save this\", or similar.",
    "- You discover a reusable coding rule or project convention.",
    "- You fix a bug or recurring bug pattern. Do not record the bug itself; record the design lesson behind it (see \"Bug fixes: record the lesson, not the incident\").",
    "- You learn project-specific context (domain rules, API quirks, infrastructure facts) that would otherwise be rediscovered from scratch in a future session.",
    "- You complete an architecture or workflow change that defines a new norm (e.g. a new deployment procedure).",
    "",
    "User feedback is a high-priority memory signal:",
    "- When the user corrects how you communicate, reason, edit, test, or collaborate, treat the correction as durable by default.",
    "- When the user confirms that a non-obvious approach worked well and wants it repeated, treat that as durable feedback.",
    "- Do not wait for the user to say \"remember this\" or \"save this\". An unscoped correction or preference applies to future conversations by default.",
    "- Propose new durable feedback with memory_propose in the same turn. Use specific content and appropriate tags such as feedback and communication.",
    "- In feedback content, state the rule or preference and when to apply it; include the user's reason when one is provided.",
    "- If a related memory may already exist, use memory_read first instead of proposing a duplicate.",
    "",
    "LLM-proactive memory: propose without any user cue when you discover:",
    "- A technical gotcha or non-obvious API behavior confirmed during this session (e.g. a library limitation, a wrong assumption corrected by evidence).",
    "- A project-specific domain fact (business rule, field mapping, naming convention) that took investigation to establish.",
    "- A completed workflow or architecture change that all future sessions should follow.",
    "- Any lesson where the 'would a future session waste time rediscovering this?' test is YES.",
    "",
    "Do not propose instructions explicitly limited to the current answer, task, file, or one-time situation. A task-local implementation request is not automatically a reusable preference or project convention. Also do not propose information already in AGENTS.md or project documentation, or obvious general programming knowledge.",
    "",
    "## Do not record what a simple query can answer",
    "",
    "Do not propose facts that a future session can get with one cheap, read-only lookup: the current production migration version, row counts, which entities or jobs exist, a deployed commit, a config value (including values already set in env files or deploy config), a file or table listing, or a metric's current value. These go stale quickly and the lookup is always more accurate than a memory.",
    "The test is the cost of the lookup, not the topic. If obtaining the fact took real effort (a browser capture, a DBA request, a multi-step investigation, access a normal session lacks), it is worth recording even if it looks like plain data.",
    "Record instead what the lookup cannot tell you: why something is the way it is, a rule, a trap, or how to reach the data (which tool, which query, which parameter). If a memory would only say \"X is currently Y\", skip it. A memory about where to look is fine; a memory holding the answer is not.",
    "",
    "## Bug fixes: record the lesson, not the incident",
    "",
    "A bug report (which table, which column, which dashboard, what the numbers were) helps only the one who reads that fix. The next session needs the guidance the bug teaches. Before proposing a memory after a bug fix, work through these steps:",
    "1. Root cause: why did the bug happen, in one sentence, at the level of design or process rather than the single line that was wrong?",
    "2. Generalize: what class of work can hit the same cause again (modeling a new table, writing a new extractor, adding a field, building a new card)?",
    "3. Rule: what should a future session check or do BEFORE and WHILE doing that kind of work so the bug never occurs? Write it as an actionable rule.",
    "4. Evidence: keep the incident as one short example that proves the rule matters (what went wrong, the size of the damage), not as the main content.",
    "5. Title and body lead with the rule and the situation where it applies, not with the incident. Bad: 'stk_inventory lost rows because lot_no was missing from the primary key'. Good: 'Before modeling or extracting a table, define the primary key as the true data grain, or row counts silently go wrong'.",
    "6. Check related memories first (memory_read). If an existing one already states the rule, memory_update it with the new example instead of proposing another entry. If the fix itself is a one-time change with no reusable rule, do not propose anything: the commit and PR already record it.",
    "",
    "## The PR gate",
    "",
    "A proposed memory is NOT yet active. Only memories merged into `memory/active/` are valid and shown to future sessions. If you propose a memory and it has not yet been merged, it has no effect yet.",
    "",
    "## Keeping memory consistent",
    "",
    "Memories go stale or contradict each other over time. Never leave two active entries that disagree.",
    "- If the user's current statement contradicts a memory visible in the index, resolve it in the same turn.",
    "- A refinement or added detail: memory_update the existing entry (this proposes a replacement).",
    "- A reversal or a replacement by a different rule: memory_propose with supersedes=[old id], so the old entry is retired with a link and a reason.",
    "- A memory that is simply no longer true: memory_delete with a short reason (this proposes a retirement).",
    "- Before memory_propose, compare the new fact against the titles in the index. A paraphrase in different words is still a duplicate.",
    "- When the index lists related memories, memory_read them and act on any that duplicate, contradict, or are outdated by the new proposal. If they legitimately coexist, leave them.",
    "",
    "## Granularity and title-content coherence",
    "",
    "Each memory entry must be a single, focused fact or rule. Do not bundle unrelated behaviors into one entry just because they involve the same tool or domain.",
    "",
    "**Title must summarize the full content.** A future LLM reading only the title in the index should be able to tell whether to memory_read that entry. If the title does not cover part of the content, that part will be silently ignored — the LLM will never load it.",
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
].join("\n");
//# sourceMappingURL=prompt.js.map