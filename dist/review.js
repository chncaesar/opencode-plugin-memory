import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { memoryDir } from "./storage.js";
/**
 * Review state: findings from the background semantic audit plus "keep as is"
 * dismissals. Stored in .opencode/memory/review.json.
 *
 * A finding or dismissal is only valid while the entries it refers to are
 * unchanged: both carry a hash of those entries' text, and editing any of them
 * invalidates the record so the new text is looked at again.
 */
const REVIEW_FILE = "review.json";
export const RELATIONS = ["duplicate", "refinement", "contradiction"];
export function emptyReviewState() {
    return { version: 1, lastAuditAt: "", lastHash: "", findings: [], dismissed: [] };
}
export function reviewFilePath(projectDir) {
    return path.join(memoryDir(projectDir), REVIEW_FILE);
}
// ─── Hashing ─────────────────────────────────────────────────────────────────
function entryFingerprint(e) {
    return JSON.stringify([e.id, e.title, e.content, [...(e.tags ?? [])].sort()]);
}
/** Stable hash of the given entries' text (order-independent). */
export function hashEntries(entries) {
    const parts = entries.map(entryFingerprint).sort();
    return crypto.createHash("sha1").update(parts.join("\n")).digest("hex");
}
export function activeEntries(store) {
    return store.entries.filter((e) => !e.archived);
}
export function hashActive(store) {
    return hashEntries(activeEntries(store));
}
function hashIds(store, ids) {
    const found = [];
    for (const id of ids) {
        const e = store.entries.find((x) => x.id === id && !x.archived);
        if (!e)
            return null;
        found.push(e);
    }
    return hashEntries(found);
}
// ─── Persistence ─────────────────────────────────────────────────────────────
function isRelation(v) {
    return typeof v === "string" && RELATIONS.includes(v);
}
function sanitize(raw) {
    const out = emptyReviewState();
    if (!raw || typeof raw !== "object")
        return out;
    const r = raw;
    if (typeof r["lastAuditAt"] === "string")
        out.lastAuditAt = r["lastAuditAt"];
    if (typeof r["lastHash"] === "string")
        out.lastHash = r["lastHash"];
    if (Array.isArray(r["findings"])) {
        for (const f of r["findings"]) {
            if (!f || typeof f !== "object")
                continue;
            const x = f;
            if (Array.isArray(x["ids"]) && x["ids"].every((i) => typeof i === "string") && x["ids"].length >= 2 &&
                isRelation(x["relation"]) && typeof x["reason"] === "string" && typeof x["hash"] === "string") {
                out.findings.push({
                    ids: [...x["ids"]].sort(),
                    relation: x["relation"],
                    reason: x["reason"],
                    hash: x["hash"],
                });
            }
        }
    }
    if (Array.isArray(r["dismissed"])) {
        for (const d of r["dismissed"]) {
            if (!d || typeof d !== "object")
                continue;
            const x = d;
            if (typeof x["key"] === "string" && typeof x["hash"] === "string") {
                out.dismissed.push({ key: x["key"], hash: x["hash"] });
            }
        }
    }
    return out;
}
/** Read review.json; a missing or corrupt file yields an empty state. */
export async function readReviewState(projectDir) {
    try {
        const text = await fs.readFile(reviewFilePath(projectDir), "utf8");
        return sanitize(JSON.parse(text));
    }
    catch {
        return emptyReviewState();
    }
}
/** Write review.json atomically (temp file + rename) so readers never see a partial file. */
export async function writeReviewState(projectDir, state) {
    const dir = memoryDir(projectDir);
    await fs.mkdir(dir, { recursive: true });
    const final = reviewFilePath(projectDir);
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    await fs.rename(tmp, final);
}
// ─── Items needing attention ─────────────────────────────────────────────────
const PLACEHOLDER_TAGS = new Set(["test", "tmp", "temp", "placeholder", "测试", "临时"]);
const PLACEHOLDER_TITLE = /^\s*(test|tmp|temp|placeholder|测试|临时)(\b|[\s:：_-]|$)/i;
/** Entries that look like leftovers, detected by explicit markers only (no similarity). */
export function findPlaceholders(store) {
    return activeEntries(store).filter((e) => (e.tags ?? []).some((t) => PLACEHOLDER_TAGS.has(t.toLowerCase())) || PLACEHOLDER_TITLE.test(e.title));
}
const DAY_MS = 24 * 60 * 60 * 1000;
/** Active entries whose latest of added/updated is older than staleDays, oldest first. */
export function findAging(store, staleDays, now = new Date()) {
    const out = [];
    for (const entry of activeEntries(store)) {
        const stamp = Date.parse(entry.updated ?? entry.added);
        if (Number.isNaN(stamp))
            continue;
        const ageDays = Math.floor((now.getTime() - stamp) / DAY_MS);
        if (ageDays >= staleDays)
            out.push({ entry, ageDays });
    }
    return out.sort((a, b) => b.ageDays - a.ageDays);
}
/** Key identifying a reviewable item; used for dismissals. */
export function findingKey(ids) {
    return [...ids].sort().join("+");
}
function isDismissed(state, key, hash) {
    return state.dismissed.some((d) => d.key === key && d.hash === hash);
}
/**
 * Items the LLM should look at: audit findings whose entries are all still
 * active and unchanged, and placeholder entries, minus anything dismissed
 * against the current text.
 */
export function collectAttention(store, state) {
    const items = [];
    for (const f of state.findings) {
        const hash = hashIds(store, f.ids);
        if (hash === null || hash !== f.hash)
            continue;
        const key = findingKey(f.ids);
        if (isDismissed(state, key, hash))
            continue;
        items.push({ kind: "audit", key, finding: f });
    }
    for (const e of findPlaceholders(store)) {
        const hash = hashEntries([e]);
        if (isDismissed(state, e.id, hash))
            continue;
        items.push({ kind: "placeholder", key: e.id, entry: e });
    }
    return items;
}
/**
 * Record "keep both / keep as is" for the given item keys. Unknown keys (not a
 * current attention item) are reported and ignored.
 */
export function dismissItems(store, state, keys) {
    const current = new Map(collectAttention(store, state).map((i) => [i.key, i]));
    const dismissed = [];
    const unknown = [];
    const next = { ...state, dismissed: [...state.dismissed] };
    for (const key of new Set(keys)) {
        const item = current.get(key);
        if (!item) {
            unknown.push(key);
            continue;
        }
        const hash = item.kind === "audit" ? item.finding.hash : hashEntries([item.entry]);
        next.dismissed = next.dismissed.filter((d) => d.key !== key);
        next.dismissed.push({ key, hash });
        dismissed.push(key);
    }
    return { state: next, dismissed, unknown };
}
/** Drop dismissals and findings that no longer match any entry text. */
export function pruneState(store, state) {
    const findings = state.findings.filter((f) => hashIds(store, f.ids) === f.hash);
    const dismissed = state.dismissed.filter((d) => hashIds(store, d.key.split("+")) === d.hash);
    return { ...state, findings, dismissed };
}
// ─── Presentation ────────────────────────────────────────────────────────────
/** One-line hint for the system prompt; empty string when nothing needs attention. */
export function nudgeLine(items) {
    if (items.length === 0)
        return "";
    const conflicts = items.filter((i) => i.kind === "audit").length;
    const placeholders = items.length - conflicts;
    const bits = [];
    if (conflicts > 0)
        bits.push(`${conflicts} possible memory conflict${conflicts === 1 ? "" : "s"}`);
    if (placeholders > 0)
        bits.push(`${placeholders} placeholder-like memor${placeholders === 1 ? "y" : "ies"}`);
    return `Memory maintenance: ${bits.join(" and ")}. Run memory_review when convenient.`;
}
export function clip(text, max) {
    return text.length <= max ? text : text.slice(0, max) + " …";
}
function entryBlock(e) {
    const tags = e.tags && e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
    const when = e.updated ? `updated ${e.updated}` : `added ${e.added}`;
    return [
        `  [${e.id}]${tags} ${e.title} (${when})`,
        `    ${e.content.replace(/\n/g, "\n    ")}`,
    ];
}
export function formatReview(store, items, aging, staleDays, auditInfo) {
    const lines = [];
    const audit = items.filter((i) => i.kind === "audit");
    const placeholders = items.filter((i) => i.kind === "placeholder");
    lines.push("## Possible conflicts (from background audit)");
    if (audit.length === 0) {
        lines.push(auditInfo.enabled
            ? auditInfo.lastAuditAt
                ? `None pending. Last audit: ${auditInfo.lastAuditAt}.`
                : "None pending. No audit has completed yet."
            : "Background audit is disabled.");
    }
    for (const item of audit) {
        const f = item.finding;
        lines.push("", `key: ${item.key}`, `relation: ${f.relation} — ${f.reason}`);
        for (const id of f.ids) {
            const e = store.entries.find((x) => x.id === id);
            if (e)
                lines.push(...entryBlock(e));
        }
        lines.push(f.relation === "duplicate"
            ? "  suggested: memory_add with supersedes (merge into one), or memory_delete the weaker one"
            : f.relation === "refinement"
                ? "  suggested: memory_update the broader entry with the detail, then memory_delete the narrower one"
                : "  suggested: decide which is true now; memory_add with supersedes for the loser, or dismiss if they apply to different cases");
    }
    lines.push("", "## Placeholder-like entries");
    if (placeholders.length === 0)
        lines.push("None.");
    for (const item of placeholders) {
        lines.push("", `key: ${item.key}`, ...entryBlock(item.entry), "  suggested: memory_delete with a reason, or dismiss if intentional");
    }
    lines.push("", `## Aging entries (not touched for ${staleDays}+ days; informational)`);
    if (aging.length === 0)
        lines.push("None.");
    for (const a of aging) {
        lines.push("", `${a.ageDays} days old`, ...entryBlock(a.entry));
    }
    if (aging.length > 0) {
        lines.push("", "For aging entries: check they still hold. If yes, call memory_update with only the id to re-confirm; if not, memory_update the content or memory_delete with a reason.");
    }
    lines.push("", 'To record "keep as is" for an item, call memory_review with dismiss=[<key>, ...].');
    return lines.join("\n");
}
//# sourceMappingURL=review.js.map