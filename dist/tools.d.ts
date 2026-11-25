import type { ToolDefinition } from "@opencode-ai/plugin/tool";
import type { PluginConfig, RetiredReason } from "./types.js";
import type { Logger } from "./logging.js";
import { type StoreSet } from "./stores.js";
type MemoryToolSet = {
    memory_propose: ToolDefinition;
    memory_update: ToolDefinition;
    memory_delete: ToolDefinition;
    memory_read: ToolDefinition;
    memory_review: ToolDefinition;
    memory_publish: ToolDefinition;
};
/** Map a free-text retirement reason onto the fixed vocabulary (default `stale`). */
export declare function mapRetireReason(reason?: string): RetiredReason;
/** How the tools resolve the stores for a session directory. Injectable for tests. */
export type StoreResolver = (directory: string) => Promise<StoreSet>;
/**
 * Create the six memory tools bound to the given plugin config and logger.
 * Each write tool only ever PROPOSES: it writes a file into the chosen store's
 * `.memory/staging/`. The merged store under `memory/active/` is never edited by
 * any tool. An unavailable project store is never used as a write or read
 * target; project-scoped calls return an actionable message instead.
 */
export declare function createMemoryTools(config: PluginConfig, logger: Logger, resolve?: StoreResolver): MemoryToolSet;
export {};
//# sourceMappingURL=tools.d.ts.map