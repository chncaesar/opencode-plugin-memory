import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { collectAttention, dismissItems, emptyReviewState, findAging, findPlaceholders, findingKey, formatReview, hashEntries, nudgeLine, pruneState, readReviewState, writeReviewState, } from "./review.js";
function e(id, title, over = {}) {
    return { id, title, content: `body of ${title}`, added: "2026-09-01", archived: false, ...over };
}
function store(...entries) {
    return { entries, nextSeq: entries.length + 1 };
}
function finding(s, ids, relation = "duplicate") {
    const involved = ids.map((i) => s.entries.find((x) => x.id === i));
    return { ids: [...ids].sort(), relation, reason: "r", hash: hashEntries(involved) };
}
describe("findPlaceholders", () => {
    it("flags test tags and test-like titles, not ordinary entries", () => {
        const s = store(e("MEM-001", "opencode-plugin-memory 插件加载验证", { tags: ["test"] }), e("MEM-002", "测试 memory_add"), e("MEM-003", "Temp: scratch note"), e("MEM-004", "Testing strategy: use node:test"), e("MEM-005", "WebFetch 必须走 subagent", { tags: ["workflow"] }));
        assert.deepEqual(findPlaceholders(s).map((x) => x.id), ["MEM-001", "MEM-002", "MEM-003"]);
    });
    it("ignores archived entries", () => {
        assert.equal(findPlaceholders(store(e("MEM-001", "x", { tags: ["test"], archived: true }))).length, 0);
    });
});
describe("findAging", () => {
    const now = new Date("2026-12-01T00:00:00Z");
    it("uses the later of added/updated and sorts oldest first", () => {
        const s = store(e("MEM-001", "old", { added: "2026-01-01" }), e("MEM-002", "old but touched", { added: "2026-01-01", updated: "2026-11-20" }), e("MEM-003", "oldest", { added: "2025-06-01" }));
        const out = findAging(s, 90, now);
        assert.deepEqual(out.map((a) => a.entry.id), ["MEM-003", "MEM-001"]);
        assert.ok(out[0].ageDays > out[1].ageDays);
    });
});
describe("collectAttention", () => {
    const s = store(e("MEM-001", "A"), e("MEM-002", "B"), e("MEM-003", "C"));
    it("returns valid findings", () => {
        const st = { ...emptyReviewState(), findings: [finding(s, ["MEM-001", "MEM-002"])] };
        const items = collectAttention(s, st);
        assert.equal(items.length, 1);
        assert.equal(items[0].key, "MEM-001+MEM-002");
    });
    it("drops a finding when an involved entry was edited", () => {
        const st = { ...emptyReviewState(), findings: [finding(s, ["MEM-001", "MEM-002"])] };
        const edited = store(e("MEM-001", "A changed"), e("MEM-002", "B"), e("MEM-003", "C"));
        assert.equal(collectAttention(edited, st).length, 0);
    });
    it("drops a finding when an involved entry was archived", () => {
        const st = { ...emptyReviewState(), findings: [finding(s, ["MEM-001", "MEM-002"])] };
        const archived = store(e("MEM-001", "A", { archived: true }), e("MEM-002", "B"));
        assert.equal(collectAttention(archived, st).length, 0);
    });
    it("includes placeholders", () => {
        const sp = store(e("MEM-001", "x", { tags: ["test"] }));
        assert.deepEqual(collectAttention(sp, emptyReviewState()).map((i) => [i.kind, i.key]), [["placeholder", "MEM-001"]]);
    });
});
describe("dismissItems", () => {
    const s = store(e("MEM-001", "A"), e("MEM-002", "B"));
    it("hides a dismissed finding until an involved entry changes", () => {
        const st0 = { ...emptyReviewState(), findings: [finding(s, ["MEM-001", "MEM-002"])] };
        const out = dismissItems(s, st0, ["MEM-001+MEM-002"]);
        assert.deepEqual(out.dismissed, ["MEM-001+MEM-002"]);
        assert.equal(collectAttention(s, out.state).length, 0);
        const edited = store(e("MEM-001", "A v2"), e("MEM-002", "B"));
        const st = { ...out.state, findings: [finding(edited, ["MEM-001", "MEM-002"], "contradiction")] };
        assert.equal(collectAttention(edited, st).length, 1);
    });
    it("dismisses a placeholder", () => {
        const sp = store(e("MEM-001", "x", { tags: ["test"] }));
        assert.equal(collectAttention(sp, dismissItems(sp, emptyReviewState(), ["MEM-001"]).state).length, 0);
    });
    it("reports unknown keys and changes nothing for them", () => {
        const out = dismissItems(s, emptyReviewState(), ["MEM-009+MEM-010"]);
        assert.deepEqual(out.unknown, ["MEM-009+MEM-010"]);
        assert.equal(out.state.dismissed.length, 0);
    });
    it("does not duplicate a dismissal when dismissed twice", () => {
        const st = { ...emptyReviewState(), findings: [finding(s, ["MEM-001", "MEM-002"])] };
        const once = dismissItems(s, st, ["MEM-001+MEM-002"]).state;
        const twice = dismissItems(s, once, ["MEM-001+MEM-002"]);
        assert.equal(twice.state.dismissed.length, 1);
    });
});
describe("pruneState", () => {
    it("removes findings and dismissals whose entries changed", () => {
        const s = store(e("MEM-001", "A"), e("MEM-002", "B"));
        const st = {
            ...emptyReviewState(),
            findings: [finding(s, ["MEM-001", "MEM-002"])],
            dismissed: [{ key: "MEM-001+MEM-002", hash: hashEntries([s.entries[0], s.entries[1]]) }],
        };
        assert.equal(pruneState(s, st).findings.length, 1);
        const changed = store(e("MEM-001", "A2"), e("MEM-002", "B"));
        const pruned = pruneState(changed, st);
        assert.equal(pruned.findings.length, 0);
        assert.equal(pruned.dismissed.length, 0);
    });
});
describe("nudgeLine", () => {
    it("is empty with no items", () => assert.equal(nudgeLine([]), ""));
    it("mentions conflicts and placeholders and the tool", () => {
        const s = store(e("MEM-001", "A"), e("MEM-002", "B"), e("MEM-003", "t", { tags: ["test"] }));
        const st = { ...emptyReviewState(), findings: [finding(s, ["MEM-001", "MEM-002"])] };
        const line = nudgeLine(collectAttention(s, st));
        assert.match(line, /1 possible memory conflict/);
        assert.match(line, /1 placeholder-like memory/);
        assert.match(line, /memory_review/);
    });
});
describe("review.json persistence", () => {
    it("round-trips and tolerates a missing or corrupt file", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-review-"));
        try {
            assert.deepEqual(await readReviewState(dir), emptyReviewState());
            const s = store(e("MEM-001", "A"), e("MEM-002", "B"));
            const st = {
                ...emptyReviewState(),
                lastAuditAt: "2026-10-01T00:00:00.000Z",
                lastHash: "h",
                findings: [finding(s, ["MEM-001", "MEM-002"])],
            };
            await writeReviewState(dir, st);
            assert.deepEqual(await readReviewState(dir), st);
            const leftovers = (await fs.readdir(path.join(dir, ".opencode/memory"))).filter((f) => f.endsWith(".tmp"));
            assert.deepEqual(leftovers, []);
            await fs.writeFile(path.join(dir, ".opencode/memory/review.json"), "{not json", "utf8");
            assert.deepEqual(await readReviewState(dir), emptyReviewState());
        }
        finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
    it("drops malformed findings when reading", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-review-"));
        try {
            await fs.mkdir(path.join(dir, ".opencode/memory"), { recursive: true });
            await fs.writeFile(path.join(dir, ".opencode/memory/review.json"), JSON.stringify({
                findings: [
                    { ids: ["MEM-001"], relation: "duplicate", reason: "x", hash: "h" },
                    { ids: ["MEM-001", "MEM-002"], relation: "bogus", reason: "x", hash: "h" },
                    5,
                ],
            }), "utf8");
            assert.equal((await readReviewState(dir)).findings.length, 0);
        }
        finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});
describe("formatReview", () => {
    it("shows the full text of entries in a finding and the dismiss key", () => {
        const s = store(e("MEM-001", "A", { content: "alpha body" }), e("MEM-002", "B", { content: "beta body" }));
        const st = { ...emptyReviewState(), findings: [finding(s, ["MEM-001", "MEM-002"], "contradiction")] };
        const out = formatReview(s, collectAttention(s, st), [], 90, { lastAuditAt: "", enabled: true });
        assert.match(out, /key: MEM-001\+MEM-002/);
        assert.match(out, /contradiction/);
        assert.match(out, /alpha body/);
        assert.match(out, /beta body/);
    });
    it("shows a long entry in full, with no truncation", () => {
        const body = "y".repeat(2500);
        const s = store(e("MEM-001", "A", { content: body }), e("MEM-002", "B", { content: "beta" }));
        const st = { ...emptyReviewState(), findings: [finding(s, ["MEM-001", "MEM-002"])] };
        const out = formatReview(s, collectAttention(s, st), [], 90, { lastAuditAt: "", enabled: true });
        assert.ok(out.includes(body), "the whole body is shown");
    });
    it("says so when the audit is disabled", () => {
        assert.match(formatReview(store(), [], [], 90, { lastAuditAt: "", enabled: false }), /disabled/);
    });
});
describe("findingKey", () => {
    it("is order independent", () => assert.equal(findingKey(["MEM-004", "MEM-001"]), "MEM-001+MEM-004"));
});
//# sourceMappingURL=review.test.js.map