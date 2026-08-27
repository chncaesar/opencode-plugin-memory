import type { Plugin } from "@opencode-ai/plugin";
/**
 * opencode-plugin-memory — project-scoped persistent memory
 *
 * Provides four tools (memory_add, memory_update, memory_delete, memory_read)
 * and injects a compact memory summary into every system prompt so the LLM
 * always knows what has been remembered without needing to read the full file.
 *
 * Storage: <projectDir>/.opencode/memory/MEMORY.md
 * Summary: <projectDir>/.opencode/memory/memory_summary.md
 */
export declare const server: Plugin;
export default server;
//# sourceMappingURL=index.d.ts.map