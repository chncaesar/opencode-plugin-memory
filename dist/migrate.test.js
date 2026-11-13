import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { migrateLegacyStores, parseLegacyMemory, mapArchivedReason } from "./migrate.js";
import { listActiveMemories, listRetiredMemories, migrationFilePath } from "./storage.js";
async function withDir(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-migrate-"));
    try {
        return await fn(dir);
    }
    finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}
const LEGACY = [
    "# OpenCode Memory",
    "<!-- nextSeq: 4 -->",
    "",
    "## Active",
    "",
    "### [MEM-001] Use int for money",
    "- added: 2026-08-26",
    "- tags: coding-style, finance",
    "Always store amounts as int cents.",
    "",
    "### [MEM-002] Old rule",
    "- added: 2026-08-20",
    "- updated: 2026-09-07",
    "Old content.",
    "",
    "## Archived",
    "",
    "### [MEM-003] Superseded thing",
    "- added: 2026-08-01",
    "- updated: 2026-09-07",
    "- archived_at: 2026-09-07",
    "- archived_reason: superseded",
    "- superseded_by: MEM-002",
    "Archived content.",
    "",
].join("\n");
describe("parseLegacyMemory", () => {
    it("splits active and archived entries with metadata", () => {
        const entries = parseLegacyMemory(LEGACY);
        assert.equal(entries.length, 3);
        const active = entries.filter((e) => !e.archived);
        const archived = entries.filter((e) => e.archived);
        assert.equal(active.length, 2);
        assert.equal(archived.length, 1);
        assert.deepEqual(active.find((e) => e.id === "MEM-001").tags, ["coding-style", "finance"]);
        assert.equal(archived[0].supersededBy, "MEM-002");
        assert.equal(archived[0].archivedReason, "superseded");
    });
});
describe("mapArchivedReason", () => {
    it("maps superseded to superseded and everything else to stale", () => {
        assert.equal(mapArchivedReason("superseded"), "superseded");
        assert.equal(mapArchivedReason("wrong"), "stale");
        assert.equal(mapArchivedReason(undefined), "stale");
    });
});
describe("migrateLegacyStores", () => {
    it("converts active + archived + supersede links into per-file memories", async () => {
        await withDir(async (dir) => {
            await fs.mkdir(path.join(dir, ".opencode/memory"), { recursive: true });
            await fs.writeFile(path.join(dir, ".opencode/memory/MEMORY.md"), LEGACY, "utf8");
            const converted = await migrateLegacyStores(dir);
            assert.equal(converted, 3);
            const active = await listActiveMemories(dir);
            const retired = await listRetiredMemories(dir);
            assert.equal(active.length, 2);
            assert.equal(retired.length, 1);
            // The retired entry keeps its body and reason, and its superseded_by is
            // re-linked to the new id of MEM-002 (the "Old rule" entry).
            const oldRule = active.find((m) => m.title === "Old rule");
            const superseded = retired[0];
            assert.equal(superseded.title, "Superseded thing");
            assert.equal(superseded.body, "Archived content.");
            assert.equal(superseded.retiredReason, "superseded");
            assert.equal(superseded.supersededBy, oldRule.id);
            // Active entries carry migration provenance.
            const migrated = active.find((m) => m.title === "Use int for money");
            assert.equal(migrated.author, "unknown");
            assert.equal(migrated.source, "migrated from legacy MEMORY.md");
            assert.equal(migrated.proposedAt, "2026-08-26");
            // No derived index file is written; the prompt index is computed later.
            await assert.rejects(fs.access(path.join(dir, "memory/_summary.md")));
            // The mapping sidecar resolves old → new ids.
            const map = JSON.parse(await fs.readFile(migrationFilePath(dir), "utf8"));
            assert.equal(typeof map.mapped["MEM-001"], "string");
            assert.equal(map.mapped["MEM-002"], oldRule.id);
            // Legacy file is left in place.
            await fs.access(path.join(dir, ".opencode/memory/MEMORY.md"));
        });
    });
    it("is idempotent — a second run changes nothing", async () => {
        await withDir(async (dir) => {
            await fs.mkdir(path.join(dir, ".agents/memory"), { recursive: true });
            await fs.writeFile(path.join(dir, ".agents/memory/MEMORY.md"), LEGACY, "utf8");
            assert.equal(await migrateLegacyStores(dir), 3);
            const activeAfter = await listActiveMemories(dir);
            const retiredAfter = await listRetiredMemories(dir);
            assert.equal(await migrateLegacyStores(dir), 0);
            assert.equal((await listActiveMemories(dir)).length, activeAfter.length);
            assert.equal((await listRetiredMemories(dir)).length, retiredAfter.length);
        });
    });
    it("is a no-op when there is no legacy store and creates nothing on disk", async () => {
        await withDir(async (dir) => {
            assert.equal(await migrateLegacyStores(dir), 0);
            assert.equal((await listActiveMemories(dir)).length, 0);
            await assert.rejects(fs.access(path.join(dir, "memory")));
        });
    });
    it("converts both legacy locations when both are present", async () => {
        await withDir(async (dir) => {
            const a = ["# OpenCode Memory", "<!-- nextSeq: 2 -->", "", "## Active", "", "### [MEM-001] A", "- added: 2026-01-01", "A body.", "", "## Archived", ""].join("\n");
            const b = ["# OpenCode Memory", "<!-- nextSeq: 2 -->", "", "## Active", "", "### [MEM-002] B", "- added: 2026-01-02", "B body.", "", "## Archived", ""].join("\n");
            await fs.mkdir(path.join(dir, ".opencode/memory"), { recursive: true });
            await fs.mkdir(path.join(dir, ".agents/memory"), { recursive: true });
            await fs.writeFile(path.join(dir, ".opencode/memory/MEMORY.md"), a, "utf8");
            await fs.writeFile(path.join(dir, ".agents/memory/MEMORY.md"), b, "utf8");
            assert.equal(await migrateLegacyStores(dir), 2);
            const active = await listActiveMemories(dir);
            assert.equal(active.length, 2);
            assert.deepEqual(active.map((m) => m.title).sort(), ["A", "B"]);
        });
    });
});
//# sourceMappingURL=migrate.test.js.map