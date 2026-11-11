import type { Logger } from "./logging.js";
import type { RetiredReason } from "./types.js";
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
 * Migrate any unmigrated legacy entries, regenerate the summary, and return the
 * number of entries converted (0 when there was nothing to do).
 */
export declare function migrateLegacyStores(projectDir: string, logger?: Logger): Promise<number>;
export {};
//# sourceMappingURL=migrate.d.ts.map