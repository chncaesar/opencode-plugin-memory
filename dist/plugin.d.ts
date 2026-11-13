import type { Plugin, PluginOptions } from "@opencode-ai/plugin";
import { type PluginConfig } from "./types.js";
import { type ModelCall } from "./audit.js";
/**
 * Parse and validate plugin options from opencode.json.
 * All options are optional; missing values fall back to DEFAULT_CONFIG.
 *
 * Example opencode.json entry:
 *   "plugin": [["opencode-plugin-memory", { "maxSummaryChars": 10000 }]]
 */
export declare function resolveConfig(options?: PluginOptions): PluginConfig;
/**
 * Tell the model when staged proposals have no pull request yet. The background
 * audit stages retire proposals while no model is in the loop, so without this
 * nothing would ever prompt a `memory_publish` call. Same rule as for
 * memory_propose/update/delete: the model publishes, the human merges.
 */
export declare function pendingPublishNotice(directory: string): Promise<string | null>;
/**
 * opencode-plugin-memory — PR-gated project memory.
 *
 * The agent only PROPOSES memories by writing files into `.memory/staging/`. A
 * bot (see bot.ts) turns those into pull requests; a human merges them; merged
 * memories live under `memory/active/`. Their titles are indexed on every
 * session start; full bodies load lazily through `memory_read`.
 *
 * A background semantic audit runs after sessions go idle and asks a model to
 * flag duplicate / refining / contradicting memories; each finding becomes a
 * retirement proposal, which the bot turns into a PR.
 *
 * Layout:
 *   .memory/staging/   machine-local proposals (git-ignored)
 *   memory/active/     merged truth
 *   memory/retired/    retired memories
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
            text: V2GenerateText;
        };
    };
};
/** `ctx.experimental.generate.text`: plugin-context methods take `requestOptions` (an AbortSignal) as the last argument. */
export type V2GenerateText = (input: {
    prompt: string;
    model?: {
        providerID: string;
        id: string;
    };
}, requestOptions?: {
    signal?: AbortSignal;
}) => Promise<{
    text: string;
}>;
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
 * Model call for the V2 audit, with a timeout.
 *
 * A timeout rejects the call and signals abort through the AbortSignal passed as
 * `requestOptions`. OpenCode 2.2.7 does NOT honour that signal for
 * `experimental.generate.text` (packages/plugin/src/promise/adapter.ts drops the
 * second argument), so the host request keeps running after a timeout. What
 * actually prevents a pile-up is the guard below: while the previous request is
 * still unsettled, the next call fails fast instead of starting a second
 * concurrent request. The signal is still passed so a host that does honour it
 * cancels the request.
 */
export declare function createV2ModelCall(generate: V2GenerateText, model?: {
    providerID: string;
    id: string;
}, timeoutMs?: number): ModelCall;
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