import type { ToolDefinition } from "@opencode-ai/plugin/tool";
import type { PluginConfig } from "./types.js";
import type { Logger } from "./logging.js";
type MemoryToolSet = {
    memory_add: ToolDefinition;
    memory_update: ToolDefinition;
    memory_delete: ToolDefinition;
    memory_read: ToolDefinition;
    memory_review: ToolDefinition;
};
import type { AuditOutcome } from "./audit.js";
export type ToolDeps = {
    /** Runs a forced audit (bypasses the interval) and returns its outcome. */
    runAuditNow?: () => Promise<AuditOutcome>;
};
/**
 * Create all five memory tools bound to the given plugin config and logger.
 * Each tool reads and writes from `<projectDir>/.opencode/memory/MEMORY.md`.
 */
export declare function createMemoryTools(config: PluginConfig, logger: Logger, deps?: ToolDeps): MemoryToolSet;
export {};
//# sourceMappingURL=tools.d.ts.map