import type { Plugin, PluginOptions } from "@opencode-ai/plugin";
import { type PluginConfig } from "./types.js";
/**
 * Parse and validate plugin options from opencode.json.
 * All options are optional; missing values fall back to DEFAULT_CONFIG.
 *
 * Example opencode.json entry:
 *   "plugin": [["opencode-plugin-memory", { "maxSummaryChars": 10000 }]]
 */
export declare function resolveConfig(options?: PluginOptions): PluginConfig;
/**
 * opencode-plugin-memory — PR-gated project memory.
 *
 * The agent only PROPOSES memories by writing files into `.memory/staging/`. A
 * bot (see bot.ts) turns those into pull requests; a human merges them; merged
 * memories live under `memory/active/` and are indexed in `memory/_summary.md`,
 * which is the only memory content injected into the system prompt.
 *
 * A background semantic audit runs after sessions go idle and asks a model to
 * flag duplicate / refining / contradicting memories; each finding becomes a
 * retirement proposal, which the bot turns into a PR.
 *
 * Layout:
 *   .memory/staging/   machine-local proposals (git-ignored)
 *   memory/active/     merged truth
 *   memory/retired/    retired memories
 *   memory/_summary.md committed one-line-per-active index
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