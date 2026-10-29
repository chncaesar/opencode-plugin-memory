/**
 * The restricted agent the background audit runs in.
 *
 * It is registered from the plugin's `config` hook. The key properties:
 * - `prompt` replaces OpenCode's provider prompt (request.ts uses agent.prompt
 *   instead of SystemPrompt.provider when set).
 * - `permission: { "*": "deny" }` removes every tool schema from the request
 *   (resolveTools filters by permission) and also drops the MCP instructions
 *   and skills list from the system prompt.
 * - `steps: 1` prevents an agentic loop.
 *
 * Project and global AGENTS.md are still injected for every session; that is
 * not suppressible per agent and is accepted as a small fixed cost.
 */

export const AUDIT_AGENT_NAME = "memory-audit"

export const AUDIT_AGENT_PROMPT = [
  "You maintain a project memory store.",
  "Your only job is to compare memory entries and report duplication, refinement or contradiction between them.",
  "You have no tools and no other duties. Do not ask questions. Reply with JSON only, exactly as instructed.",
].join("\n")

type AuditAgentConfig = {
  agent?: Record<string, unknown>
  small_model?: string
}

/**
 * Add the audit agent to a resolved OpenCode config, in place.
 * A user-defined agent with the same name wins and is left untouched.
 */
export function registerAuditAgent(config: AuditAgentConfig): void {
  const agents = (config.agent ??= {})
  if (agents[AUDIT_AGENT_NAME]) return
  const small = typeof config.small_model === "string" && config.small_model.length > 0 ? config.small_model : undefined
  agents[AUDIT_AGENT_NAME] = {
    description:
      "Internal agent used by opencode-plugin-memory to audit project memories for duplicates and contradictions.",
    mode: "subagent",
    hidden: true,
    steps: 1,
    prompt: AUDIT_AGENT_PROMPT,
    permission: { "*": "deny" },
    ...(small ? { model: small } : {}),
  }
}
