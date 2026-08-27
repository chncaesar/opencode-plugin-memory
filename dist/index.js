import { DEFAULT_CONFIG } from "./types.js";
import { createMemoryTools } from "./tools.js";
import { readSummary } from "./summary.js";
import { createLogger } from "./logging.js";
/**
 * Parse and validate plugin options from opencode.json.
 * All options are optional; missing values fall back to DEFAULT_CONFIG.
 *
 * Example opencode.json entry:
 *   "plugin": [["opencode-plugin-memory", { "maxSummaryChars": 3000 }]]
 */
function resolveConfig(options) {
    if (!options || typeof options !== "object")
        return DEFAULT_CONFIG;
    const raw = options;
    return {
        maxSummaryChars: typeof raw["maxSummaryChars"] === "number" && raw["maxSummaryChars"] > 0
            ? raw["maxSummaryChars"]
            : DEFAULT_CONFIG.maxSummaryChars,
        enableLog: typeof raw["enableLog"] === "boolean"
            ? raw["enableLog"]
            : DEFAULT_CONFIG.enableLog,
    };
}
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
export const server = async (input, options) => {
    const config = resolveConfig(options);
    const logger = createLogger(input.directory, config.enableLog);
    const tools = createMemoryTools(config, logger);
    const hooks = {
        // ── Register the four memory tools ────────────────────────────────────
        tool: {
            memory_add: tools.memory_add,
            memory_update: tools.memory_update,
            memory_delete: tools.memory_delete,
            memory_read: tools.memory_read,
        },
        // ── Inject memory summary into every system prompt ────────────────────
        "experimental.chat.system.transform": async (_input, output) => {
            const summary = await readSummary(input.directory);
            if (!summary)
                return;
            output.system.push(summary);
        },
    };
    return hooks;
};
// Default export for compatibility with opencode's plugin loader
export default server;
//# sourceMappingURL=index.js.map