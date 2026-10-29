import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AUDIT_AGENT_NAME, AUDIT_AGENT_PROMPT, registerAuditAgent } from "./auditAgent.js";
describe("registerAuditAgent", () => {
    it("registers a hidden, tool-less, single-step subagent", () => {
        const cfg = {};
        registerAuditAgent(cfg);
        const a = cfg.agent[AUDIT_AGENT_NAME];
        assert.equal(a.mode, "subagent");
        assert.equal(a.hidden, true);
        assert.equal(a.steps, 1);
        assert.equal(a.prompt, AUDIT_AGENT_PROMPT);
        assert.deepEqual(a.permission, { "*": "deny" });
        assert.equal(a.model, undefined);
    });
    it("uses small_model when configured", () => {
        const cfg = { small_model: "anthropic/claude-haiku" };
        registerAuditAgent(cfg);
        assert.equal(cfg.agent[AUDIT_AGENT_NAME].model, "anthropic/claude-haiku");
    });
    it("keeps a user-defined agent with the same name", () => {
        const cfg = { agent: { [AUDIT_AGENT_NAME]: { mode: "primary", prompt: "mine" } } };
        registerAuditAgent(cfg);
        assert.deepEqual(cfg.agent[AUDIT_AGENT_NAME], { mode: "primary", prompt: "mine" });
    });
    it("is idempotent", () => {
        const cfg = {};
        registerAuditAgent(cfg);
        const first = JSON.stringify(cfg.agent);
        registerAuditAgent(cfg);
        assert.equal(JSON.stringify(cfg.agent), first);
    });
    it("preserves other agents", () => {
        const cfg = { agent: { build: { mode: "primary" } } };
        registerAuditAgent(cfg);
        assert.ok(cfg.agent["build"]);
        assert.ok(cfg.agent[AUDIT_AGENT_NAME]);
    });
});
//# sourceMappingURL=auditAgent.test.js.map