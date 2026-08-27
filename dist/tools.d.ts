import type { ToolDefinition } from "@opencode-ai/plugin/tool";
import type { PluginConfig } from "./types.js";
import type { Logger } from "./logging.js";
type MemoryToolSet = {
    memory_add: ToolDefinition;
    memory_update: ToolDefinition;
    memory_delete: ToolDefinition;
    memory_read: ToolDefinition;
};
/**
 * Create all four memory tools bound to the given plugin config and logger.
 * Each tool reads and writes from `<projectDir>/.opencode/memory/MEMORY.md`.
 */
export declare function createMemoryTools(config: PluginConfig, logger: Logger): MemoryToolSet;
export {};
//# sourceMappingURL=tools.d.ts.map