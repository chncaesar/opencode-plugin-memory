import type { Plugin, PluginOptions } from "@opencode-ai/plugin";
import { type PluginConfig } from "./types.js";
/**
 * Parse and validate plugin options from opencode.json.
 * All options are optional; missing values fall back to DEFAULT_CONFIG.
 *
 * Example opencode.json entry:
 *   "plugin": [["opencode-plugin-memory", { "maxSummaryChars": 3000 }]]
 */
export declare function resolveConfig(options?: PluginOptions): PluginConfig;
/**
 * opencode-plugin-memory — project-scoped persistent memory
 *
 * Provides five tools (memory_add, memory_update, memory_delete, memory_read,
 * memory_review) and injects a compact memory summary into every system prompt
 * so the LLM always knows what has been remembered without needing to read the
 * full file.
 *
 * A background audit runs after sessions go idle and records possible memory
 * conflicts in review.json; it never edits MEMORY.md.
 *
 * Storage: <projectDir>/.opencode/memory/MEMORY.md
 * Summary: <projectDir>/.opencode/memory/memory_summary.md
 * Review:  <projectDir>/.opencode/memory/review.json
 */
export declare const server: Plugin;
/** Minimal structural view of the V2 plugin context; only what this plugin uses. */
type Registration = {
    dispose: () => Promise<void>;
};
export type V2Context = {
    location: {
        directory: string;
    };
    options?: Record<string, unknown>;
    tool: {
        transform: (fn: (editor: {
            add: (t: unknown) => void;
        }) => void) => Promise<Registration>;
    };
    session: {
        hook: (name: "context" | "experimental.idle", cb: (input: any) => Promise<void> | void) => Promise<Registration>;
    };
    experimental: {
        generate: {
            text: (input: {
                prompt: string;
                model?: {
                    providerID: string;
                    id: string;
                };
            }) => Promise<{
                text: string;
            }>;
        };
    };
};
/**
 * Parse the optional `auditModel` plugin option ("providerID/modelID") into a
 * V2 model ref. Without it the host picks a default model, which may be one
 * the user cannot call (e.g. region-blocked).
 */
export declare function parseAuditModel(raw: unknown): {
    providerID: string;
    id: string;
} | undefined;
/**
 * V2 entry point. The audit uses stateless `generate.text`, so there is no
 * throwaway session and no audit agent to register or to ignore in hooks.
 * `generate.text` takes no system prompt, so system and user text are joined.
 * It uses the `auditModel` option ("providerID/modelID") when set, otherwise the
 * host's default model (the V1 audit agent preferred `small_model`).
 */
export declare function setup(ctx: V2Context): Promise<() => Promise<void>>;
export {};
//# sourceMappingURL=plugin.d.ts.map