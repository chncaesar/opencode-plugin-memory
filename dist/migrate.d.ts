import type { Logger } from "./logging.js";
import type { StoreSet } from "./stores.js";
import type { RetiredReason } from "./types.js";
/** True when the developer checkout still has a legacy single-file store. */
export declare function hasLegacyMemorySource(projectRoot: string): Promise<boolean>;
/**
 * Where legacy `MEMORY.md` may be converted automatically.
 *
 * - A managed Git project store defers it: converted files would be unmerged
 *   files inside the managed checkout — false "active" truth that could never be
 *   published or retired. The legacy file is left untouched and the prompt
 *   warns about it.
 * - A non-Git / plain-directory store keeps the historical direct conversion,
 *   where the project directory *is* the store and the user commits the result.
 */
export declare function migrateProjectMemory(stores: StoreSet, logger?: Logger): Promise<number>;
type LegacyEntry = {
    id: string;
    title: string;
    content: string;
    added: string;
    updated?: string;
    tags?: string[];
    archived: boolean;
    archivedAt?: string;
    archivedReason?: string;
    supersededBy?: string;
};
/** Parse a legacy `MEMORY.md` into its entries (Active + Archived). */
export declare function parseLegacyMemory(text: string): LegacyEntry[];
/** Map a legacy `archived_reason` onto the new retirement vocabulary. */
export declare function mapArchivedReason(reason?: string): RetiredReason;
/**
 * Migrate any unmigrated legacy entries and return the number of entries
 * converted (0 when there was nothing to do).
 *
 * Legacy source files are always read from `projectDir`, the developer checkout
 * (they are inputs that predate the managed store). Converted memories and the
 * idempotency map are written to `storeRoot`, which is the plugin-managed
 * project store when one is in use and the project directory otherwise.
 */
export declare function migrateLegacyStores(projectDir: string, logger?: Logger, storeRoot?: string): Promise<number>;
export {};
//# sourceMappingURL=migrate.d.ts.map