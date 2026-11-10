import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectSecrets } from "./secret.js";
describe("detectSecrets", () => {
    it("detects an AWS access key", () => {
        assert.deepEqual(detectSecrets("key = AKIAIOSFODNN7EXAMPLE"), ["AWS access key"]);
        assert.deepEqual(detectSecrets("ASIAIOSFODNN7EXAMPLE"), ["AWS access key"]);
    });
    it("detects GitHub tokens", () => {
        assert.deepEqual(detectSecrets(`token: ghp_${"a".repeat(36)}`), ["GitHub token"]);
        assert.deepEqual(detectSecrets(`pat: github_pat_${"a".repeat(82)}`), ["GitHub token"]);
        assert.deepEqual(detectSecrets(`gho_${"a".repeat(30)}`), ["GitHub token"]);
        assert.deepEqual(detectSecrets(`ghs_${"a".repeat(30)}`), ["GitHub token"]);
        assert.deepEqual(detectSecrets(`ghr_${"a".repeat(30)}`), ["GitHub token"]);
    });
    it("detects OpenAI keys (plain and project)", () => {
        assert.deepEqual(detectSecrets(`sk-${"a".repeat(24)}`), ["OpenAI key"]);
        assert.deepEqual(detectSecrets(`sk-proj-${"a".repeat(24)}`), ["OpenAI key"]);
    });
    it("detects Anthropic keys", () => {
        assert.deepEqual(detectSecrets(`sk-ant-${"a".repeat(24)}`), ["Anthropic key"]);
    });
    it("detects a private key block", () => {
        assert.deepEqual(detectSecrets("-----BEGIN RSA PRIVATE KEY-----"), ["private key block"]);
        assert.deepEqual(detectSecrets("-----BEGIN PRIVATE KEY-----"), ["private key block"]);
    });
    it("detects credentialed connection strings", () => {
        assert.deepEqual(detectSecrets("mongodb://user:pass@localhost/db"), ["database connection string"]);
        assert.deepEqual(detectSecrets("postgres://alice:secret@host:5432/db"), ["database connection string"]);
    });
    it("detects Stripe live keys", () => {
        assert.deepEqual(detectSecrets(`sk_live_${"a".repeat(20)}`), ["Stripe key"]);
        assert.deepEqual(detectSecrets(`pk_live_${"a".repeat(20)}`), ["Stripe key"]);
    });
    it("detects JWTs", () => {
        const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        assert.deepEqual(detectSecrets(jwt), ["JWT"]);
    });
    it("detects Slack tokens", () => {
        assert.deepEqual(detectSecrets(`xoxb-${"a".repeat(16)}`), ["Slack token"]);
    });
    it("reports several secret types at once", () => {
        const text = `aws=AKIAIOSFODNN7EXAMPLE and ghp_${"a".repeat(36)}`;
        assert.deepEqual(detectSecrets(text), ["AWS access key", "GitHub token"]);
    });
    it("does not flag the bare word password or secret", () => {
        assert.deepEqual(detectSecrets("password"), []);
        assert.deepEqual(detectSecrets("secret"), []);
        assert.deepEqual(detectSecrets("Please remember the password and the secret phrase."), []);
    });
    it("does not flag sk- test/placeholder keys", () => {
        assert.deepEqual(detectSecrets("sk-test-placeholder"), []);
        assert.deepEqual(detectSecrets("use sk-test-123 for the sandbox"), []);
    });
    it("does not flag a normal code sentence", () => {
        const text = "function total(items) { return items.reduce((s, i) => s + i.price, 0) }";
        assert.deepEqual(detectSecrets(text), []);
    });
});
//# sourceMappingURL=secret.test.js.map