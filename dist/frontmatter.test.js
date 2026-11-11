import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
describe("parseFrontmatter", () => {
    it("returns null when there is no opening delimiter", () => {
        assert.equal(parseFrontmatter("id: mem-aaaaaaaa\nbody"), null);
    });
    it("returns null when there is no closing delimiter", () => {
        assert.equal(parseFrontmatter("---\nid: mem-aaaaaaaa\n"), null);
    });
    it("parses scalar fields and a body", () => {
        const text = [
            "---",
            "id: mem-aaaaaaaa",
            "title: Store amounts as cents",
            "author: alice",
            "---",
            "Always use integer cents.",
        ].join("\n");
        const out = parseFrontmatter(text);
        assert.deepEqual(out.frontmatter, {
            id: "mem-aaaaaaaa",
            title: "Store amounts as cents",
            author: "alice",
        });
        assert.equal(out.body, "Always use integer cents.");
    });
    it("parses an array of strings from indented items", () => {
        const text = ["---", "id: mem-aaaaaaaa", "title: T", "supersedes:", "  - mem-bbbbbbbb", "  - mem-cccccccc", "---", ""].join("\n");
        const out = parseFrontmatter(text);
        assert.deepEqual(out.frontmatter["supersedes"], ["mem-bbbbbbbb", "mem-cccccccc"]);
    });
    it("parses an empty scalar value as an empty string", () => {
        const out = parseFrontmatter("---\nid: mem-aaaaaaaa\ntitle: T\nsource:\n---\n");
        assert.equal(out.frontmatter["source"], "");
    });
    it("preserves a multi-line body verbatim (aside from outer trim)", () => {
        const text = "---\nid: mem-aaaaaaaa\ntitle: T\n---\nline one\n\nline two\n";
        const out = parseFrontmatter(text);
        assert.equal(out.body, "line one\n\nline two");
    });
    it("unquotes a double-quoted scalar", () => {
        const out = parseFrontmatter('---\nid: mem-aaaaaaaa\ntitle: "a: b"\n---\n');
        assert.equal(out.frontmatter["title"], "a: b");
    });
});
describe("serializeFrontmatter", () => {
    it("emits scalars and string arrays in a canonical order", () => {
        const text = serializeFrontmatter({ id: "mem-aaaaaaaa", title: "T", supersedes: ["mem-bbbbbbbb"], intent: "propose" }, "body");
        const lines = text.split("\n");
        assert.equal(lines[0], "---");
        assert.ok(lines.includes("id: mem-aaaaaaaa"));
        assert.ok(lines.includes("title: T"));
        assert.ok(lines.includes("supersedes:"));
        assert.ok(lines.includes("  - mem-bbbbbbbb"));
        assert.ok(lines.includes("intent: propose"));
        assert.ok(lines.includes("---"));
        assert.equal(text.endsWith("body\n"), true);
    });
    it("omits empty arrays and empty bodies", () => {
        const text = serializeFrontmatter({ id: "mem-aaaaaaaa", title: "T", supersedes: [] }, "");
        assert.ok(!text.includes("supersedes"));
        assert.ok(!text.includes("  -"));
        // ends with the closing delimiter + newline, no body
        assert.equal(text, "---\nid: mem-aaaaaaaa\ntitle: T\n---\n");
    });
});
describe("round-trip", () => {
    const cases = [
        ["plain scalars", { id: "mem-aaaaaaaa", title: "Simple title", author: "alice" }, "body"],
        ["colon in value", { id: "mem-aaaaaaaa", title: "a: b with colon" }, ""],
        ["hash in value", { id: "mem-aaaaaaaa", title: "rule #5 note" }, ""],
        ["leading dash", { id: "mem-aaaaaaaa", title: "- keep this" }, ""],
        ["leading space", { id: "mem-aaaaaaaa", title: "  indented" }, ""],
        ["trailing space", { id: "mem-aaaaaaaa", title: "trailing  " }, ""],
        ["quotes and backslash", { id: "mem-aaaaaaaa", title: 'say "hi" \\ now' }, ""],
        ["newline in value", { id: "mem-aaaaaaaa", title: "line one\nline two" }, ""],
        ["empty string value", { id: "mem-aaaaaaaa", title: "", source: "" }, ""],
        ["unicode", { id: "mem-aaaaaaaa", title: "插件加载验证 — 中文", tags: ["中文", "workflow"] }, ""],
        ["string array", { id: "mem-aaaaaaaa", title: "T", supersedes: ["mem-bbbbbbbb", "mem-cccccccc"] }, ""],
        ["full memory", { id: "mem-aaaaaaaa", title: "T", tags: ["a", "b"], author: "x", source: "s", proposed_at: "2026-01-01", approved_at: "2026-01-02", supersedes: ["mem-bbbbbbbb"], retired_reason: "stale", intent: "propose" }, "body here"],
    ];
    for (const [name, frontmatter, body] of cases) {
        it(`round-trips ${name} losslessly`, () => {
            const text = serializeFrontmatter(frontmatter, body);
            const out = parseFrontmatter(text);
            assert.ok(out, "serialized output must parse");
            assert.deepEqual(out.frontmatter, frontmatter);
            assert.equal(out.body, body);
        });
    }
    it("is stable across a second serialize/parse cycle", () => {
        const fm = { id: "mem-aaaaaaaa", title: "a: b # c", tags: ["x", "y z"], intent: "retire", retired_reason: "stale" };
        const once = serializeFrontmatter(fm, "body");
        assert.equal(serializeFrontmatter(parseFrontmatter(once).frontmatter, "body"), once);
    });
});
//# sourceMappingURL=frontmatter.test.js.map