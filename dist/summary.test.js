import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { buildSummaryContent, buildSystemPrompt, extractIndexLines, generateSummary, readSummaryContent, } from "./summary.js";
import { MEMORY_POLICY_EXAMPLES, MEMORY_WRITE_POLICY } from "./prompt.js";
import { activeDir, summaryFilePath, writeMemoryFile } from "./storage.js";
function mem(id, title) {
    return { id, title, body: "c", proposedAt: "2026-01-01" };
}
async function withDir(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-summary-"));
    try {
        return await fn(dir);
    }
    finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}
describe("buildSummaryContent", () => {
    it("emits one line per memory, sorted by id", () => {
        const out = buildSummaryContent([mem("mem-bbbbbbbb", "B"), mem("mem-aaaaaaaa", "A")]);
        assert.ok(out.indexOf("[mem-aaaaaaaa] A") < out.indexOf("[mem-bbbbbbbb] B"));
    });
    it("marks an empty store", () => {
        assert.match(buildSummaryContent([]), /no active memories/);
    });
});
describe("generateSummary / readSummaryContent", () => {
    it("writes memory/_summary.md and reads it back", async () => {
        await withDir(async (dir) => {
            await writeMemoryFile(activeDir(dir), mem("mem-aaaaaaaa", "First rule"));
            await generateSummary(dir);
            const text = await readSummaryContent(dir);
            assert.match(text, /\[mem-aaaaaaaa\] First rule/);
            await fs.access(summaryFilePath(dir));
        });
    });
    it("returns an empty string when the summary is absent", async () => {
        await withDir(async (dir) => {
            assert.equal(await readSummaryContent(dir), "");
        });
    });
});
describe("extractIndexLines", () => {
    it("keeps only [mem-XXXX] lines", () => {
        const content = "<!-- header -->\n\n[mem-aaaaaaaa] A\n[mem-bbbbbbbb] B\nnoise\n";
        assert.deepEqual(extractIndexLines(content), ["[mem-aaaaaaaa] A", "[mem-bbbbbbbb] B"]);
    });
});
describe("buildSystemPrompt", () => {
    it("injects the intro and policy, and no index lines when empty", () => {
        const out = buildSystemPrompt("", 2000);
        assert.match(out, /PR-gated project memory system/);
        assert.match(out, /no active memories/);
        assert.ok(out.includes(MEMORY_WRITE_POLICY));
    });
    it("injects the index lines and never full bodies", () => {
        const content = buildSummaryContent([mem("mem-aaaaaaaa", "First rule")]);
        const out = buildSystemPrompt(content, 2000);
        assert.match(out, /\[mem-aaaaaaaa\] First rule/);
        assert.ok(out.includes(MEMORY_WRITE_POLICY));
    });
    it("truncates a long index to maxChars with a notice", () => {
        const many = Array.from({ length: 40 }, (_, i) => mem(`mem-${String(i).padStart(8, "0")}`, `Title ${i} with some words`));
        const content = buildSummaryContent(many);
        const out = buildSystemPrompt(content, 200);
        const indexPart = out.split("Project memory index:")[1].split("## When to propose")[0];
        assert.ok(indexPart.includes("showing a subset"));
        // The index section (titles only) is capped near maxChars; the policy is
        // injected separately and is not part of the truncation budget.
        assert.ok(indexPart.length <= 210);
    });
});
describe("memory-writing policy", () => {
    it("covers corrections, confirmations, temporary limits, and task-local requests", () => {
        for (const signal of ["correction", "confirmation", "temporary", "task-local"]) {
            assert.ok(MEMORY_POLICY_EXAMPLES.some((e) => e.signal === signal), `missing ${signal} example`);
        }
    });
    it("teaches the PR gate and the new tool names", () => {
        assert.match(MEMORY_WRITE_POLICY, /PROPOSE/i);
        assert.match(MEMORY_WRITE_POLICY, /memory_propose/);
        assert.match(MEMORY_WRITE_POLICY, /memory_update/);
        assert.match(MEMORY_WRITE_POLICY, /memory_delete/);
        assert.match(MEMORY_WRITE_POLICY, /merge/i);
    });
    it("preserves the granularity and title-coherence rules", () => {
        assert.match(MEMORY_WRITE_POLICY, /Granularity and title-content coherence/);
        assert.match(MEMORY_WRITE_POLICY, /Title must summarize the full content/);
    });
    it("tells the model not to record facts a simple query can answer", () => {
        assert.match(MEMORY_WRITE_POLICY, /Do not record what a simple query can answer/);
        assert.match(MEMORY_WRITE_POLICY, /production migration version/);
        assert.ok(MEMORY_POLICY_EXAMPLES.some((e) => e.decision === "skip" && /migration/i.test(e.cue)), "missing skip example for query-derivable state");
    });
    it("teaches the model to record the lesson behind a bug fix, not the incident", () => {
        assert.match(MEMORY_WRITE_POLICY, /Bug fixes: record the lesson, not the incident/);
        assert.match(MEMORY_WRITE_POLICY, /Root cause/);
        assert.match(MEMORY_WRITE_POLICY, /Generalize/);
        assert.match(MEMORY_WRITE_POLICY, /actionable rule/);
        assert.ok(MEMORY_POLICY_EXAMPLES.some((e) => e.signal === "llm-discovery" && /bug/i.test(e.cue) && /rule/i.test(e.guidance)), "missing bug-lesson example");
    });
});
//# sourceMappingURL=summary.test.js.map