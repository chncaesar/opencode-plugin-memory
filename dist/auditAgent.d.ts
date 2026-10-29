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
export declare const AUDIT_AGENT_NAME = "memory-audit";
export declare const AUDIT_AGENT_PROMPT: string;
type AuditAgentConfig = {
    agent?: Record<string, unknown>;
    small_model?: string;
};
/**
 * Add the audit agent to a resolved OpenCode config, in place.
 * A user-defined agent with the same name wins and is left untouched.
 */
export declare function registerAuditAgent(config: AuditAgentConfig): void;
export {};
//# sourceMappingURL=auditAgent.d.ts.map