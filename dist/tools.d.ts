import type { ToolDefinition } from "@opencode-ai/plugin/tool";
import type { PluginConfig, RetiredReason } from "./types.js";
import type { Logger } from "./logging.js";
type MemoryToolSet = {
    memory_propose: ToolDefinition;
    memory_update: ToolDefinition;
    memory_delete: ToolDefinition;
    memory_read: ToolDefinition;
    memory_review: ToolDefinition;
};
/** Map a free-text retirement reason onto the fixed vocabulary (default `stale`). */
export declare function mapRetireReason(reason?: string): RetiredReason;
/**
 * Create the five memory tools bound to the given plugin config and logger.
 * Each tool only ever PROPOSES: it writes a file into `.memory/staging/`. The
 * merged store under `memory/active/` is never edited by any tool.
 */
export declare function createMemoryTools(config: PluginConfig, logger: Logger): MemoryToolSet;
export {};
//# sourceMappingURL=tools.d.ts.map