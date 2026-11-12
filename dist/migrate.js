import fs from "fs/promises";
import path from "path";
import { activeDir, generateMemoryId, memoryRootDir, migrationFilePath, retiredDir, writeMemoryFile, } from "./storage.js";
import { generateSummary } from "./summary.js";
/**
 * One-time migration of the legacy single-file store into the per-file model.
 *
 * Converts BOTH legacy locations if present — `.opencode/memory/MEMORY.md` and
 * `.agents/memory/MEMORY.md` (same Active/Archived + `nextSeq` format) — into
 * one file per memory under `memory/active/` and `memory/retired/`. The legacy
 * files are left in place as backup and never deleted.
 *
 * Idempotent: a `memory/.migration.json` sidecar maps old `MEM-NNN` IDs to new
 * `mem-XXXX` IDs; entries already mapped are skipped on every run.
 */
const LEGACY_PATHS = [".opencode/memory/MEMORY.md", ".agents/memory/MEMORY.md"];
const ENTRY_HEADING_RE = /^### \[(MEM-\d+)\] (.+)$/;
/** Parse a legacy `MEMORY.md` into its entries (Active + Archived). */
export function parseLegacyMemory(text) {
    const lines = text.split("\n");
    const entries = [];
    let inArchived = false;
    let current = null;
    let bodyLines = [];
    let inMeta = false;
    const flush = () => {
        if (!current?.id || !current.title)
            return;
        const entry = {
            id: current.id,
            title: current.title,
            content: bodyLines.join("\n").trim(),
            added: current.added ?? today(),
            archived: inArchived,
        };
        if (current.updated !== undefined)
            entry.updated = current.updated;
        if (current.tags !== undefined)
            entry.tags = current.tags;
        if (inArchived) {
            if (current.archivedAt !== undefined)
                entry.archivedAt = current.archivedAt;
            if (current.archivedReason !== undefined)
                entry.archivedReason = current.archivedReason;
            if (current.supersededBy !== undefined)
                entry.supersededBy = current.supersededBy;
        }
        entries.push(entry);
        current = null;
        bodyLines = [];
    };
    for (const line of lines) {
        if (line.startsWith("## Active")) {
            flush();
            inArchived = false;
            continue;
        }
        if (line.startsWith("## Archived")) {
            flush();
            inArchived = true;
            continue;
        }
        const m = line.match(ENTRY_HEADING_RE);
        if (m) {
            flush();
            const id = m[1];
            const title = m[2];
            if (id !== undefined && title !== undefined) {
                current = { id, title };
            }
            bodyLines = [];
            inMeta = true;
            continue;
        }
        if (current) {
            if (inMeta) {
                const meta = line.match(/^- (added|updated|tags|archived_at|archived_reason|superseded_by):\s*(.*)$/);
                if (meta) {
                    const key = meta[1];
                    const val = (meta[2] ?? "").trim();
                    if (key === "added" && val)
                        current.added = val;
                    else if (key === "updated" && val)
                        current.updated = val;
                    else if (key === "tags" && val)
                        current.tags = val.split(",").map((t) => t.trim()).filter(Boolean);
                    else if (key === "archived_at" && val)
                        current.archivedAt = val;
                    else if (key === "archived_reason" && val)
                        current.archivedReason = val;
                    else if (key === "superseded_by" && val)
                        current.supersededBy = val;
                    continue;
                }
                if (line.trim() === "")
                    continue;
                inMeta = false;
            }
            bodyLines.push(line);
        }
    }
    flush();
    return entries;
}
/** Map a legacy `archived_reason` onto the new retirement vocabulary. */
export function mapArchivedReason(reason) {
    return reason === "superseded" ? "superseded" : "stale";
}
async function readMigrationMap(projectDir) {
    try {
        const text = await fs.readFile(migrationFilePath(projectDir), "utf8");
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.mapped === "object" && parsed.mapped !== null) {
            const out = {};
            for (const [k, v] of Object.entries(parsed.mapped)) {
                if (typeof v === "string")
                    out[k] = v;
            }
            return out;
        }
    }
    catch {
        // Missing or corrupt sidecar: treat as nothing migrated yet.
    }
    return {};
}
/**
 * Migrate any unmigrated legacy entries, regenerate the summary, and return the
 * number of entries converted (0 when there was nothing to do).
 */
export async function migrateLegacyStores(projectDir, logger) {
    const existing = await readMigrationMap(projectDir);
    const newAssignments = {};
    const toWrite = [];
    for (const relative of LEGACY_PATHS) {
        const legacyPath = path.join(projectDir, relative);
        let text;
        try {
            text = await fs.readFile(legacyPath, "utf8");
        }
        catch (err) {
            if (isNodeError(err) && err.code === "ENOENT")
                continue;
            throw err;
        }
        for (const entry of parseLegacyMemory(text)) {
            if (existing[entry.id] || newAssignments[entry.id])
                continue;
            const newId = generateMemoryId();
            newAssignments[entry.id] = newId;
            toWrite.push({ entry, newId });
        }
    }
    // Nothing to convert: leave the disk untouched (no memory/ folder in directories without memories).
    if (toWrite.length === 0)
        return 0;
    const combined = { ...existing, ...newAssignments };
    for (const { entry, newId } of toWrite) {
        if (entry.archived) {
            const memory = {
                id: newId,
                title: entry.title,
                body: entry.content,
                author: "unknown",
                source: "migrated from legacy MEMORY.md",
                proposedAt: entry.added,
                approvedAt: entry.updated ?? entry.added,
                retiredAt: entry.archivedAt ?? entry.updated ?? entry.added,
                retiredReason: mapArchivedReason(entry.archivedReason),
            };
            if (entry.tags !== undefined && entry.tags.length > 0)
                memory.tags = entry.tags;
            if (entry.supersededBy) {
                const replacement = combined[entry.supersededBy];
                if (replacement)
                    memory.supersededBy = replacement;
            }
            await writeMemoryFile(retiredDir(projectDir), memory);
        }
        else {
            const memory = {
                id: newId,
                title: entry.title,
                body: entry.content,
                author: "unknown",
                source: "migrated from legacy MEMORY.md",
                proposedAt: entry.added,
                approvedAt: entry.updated ?? entry.added,
            };
            if (entry.tags !== undefined && entry.tags.length > 0)
                memory.tags = entry.tags;
            await writeMemoryFile(activeDir(projectDir), memory);
        }
    }
    const finalMap = { ...existing, ...newAssignments };
    await fs.mkdir(memoryRootDir(projectDir), { recursive: true });
    await fs.writeFile(migrationFilePath(projectDir), JSON.stringify({ version: 1, mapped: finalMap }, null, 2) + "\n", "utf8");
    await generateSummary(projectDir);
    if (logger) {
        await logger.info("migration", `converted ${toWrite.length} legacy entr${toWrite.length === 1 ? "y" : "ies"}`);
    }
    return toWrite.length;
}
function today() {
    return new Date().toISOString().slice(0, 10);
}
function isNodeError(err) {
    return err instanceof Error && "code" in err;
}
//# sourceMappingURL=migrate.js.map