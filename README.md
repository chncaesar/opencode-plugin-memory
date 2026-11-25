# opencode-plugin-memory

[简体中文](README.zh-CN.md) | **English**

[![npm version](https://img.shields.io/npm/v/@chncaesar/opencode-plugin-memory)](https://www.npmjs.com/package/@chncaesar/opencode-plugin-memory)

PR-gated persistent memory for [OpenCode](https://opencode.ai): global knowledge that follows you into every repository, plus a per-repository store that travels with the project. The LLM proposes durable knowledge; a human approves it by merging a pull request before it becomes shared truth. No cloud dependency, no vector database.

> **Full user guide: <https://chncaesar.github.io/opencode-plugin-memory/>**
> Installation options, all configuration parameters, the bot, background audit, and troubleshooting live there. This README covers only the essentials.

## The core difference: merge is the only approval

The LLM never writes shared truth. It can only drop a proposal file into a machine-local, git-ignored staging folder. A memory is not valid until a human merges the pull request, so proposed, wrong, or harmful content never silently becomes shared truth.

## Two stores

- **Global** — one private repository of your own, cloned on this machine and injected into every session. Most knowledge belongs here: how a tool or API behaves, infrastructure, personal preferences, review rules.
- **Project** — the current repository's own `memory/` folder in Git, shared with whoever has the repository. Project memory is now managed through a plugin-managed sparse worktree that refreshes from the remote default branch without touching your working tree. Use it for rules that only make sense here: its architecture, its module names, its business definitions.

A proposal names its store and defaults to the global one once that clone exists; without a clone, everything stays in the project store, as it did before. Each store stages, publishes and audits independently, so one store failing never blocks the other. The two prompt sections share one size limit, and the project section keeps a guaranteed share so a large global store cannot crowd it out.

## What belongs in memory

Only what no artifact can state: what a field really means, why the obvious approach is dangerous, a boundary that forbids something. If the code, the tests or the design doc will state a rule once it is built, that is where the rule belongs — a second copy drifts at the next redesign. When a remembered rule does get built, it is retired as `implemented` and its pull request says so, leaving the code as the only source of truth.

## How it works

1. The LLM proposes a memory by writing one file to its store's `.memory/staging/` — machine-local and git-ignored (inside the global clone or the plugin-managed sparse worktree for the project store).
2. A local bot commits each proposal into `memory/active/` on its own branch and opens a pull request in the repository that store belongs to: your private memory repository for global knowledge, the project repository for its own. Publishing runs in a throwaway worktree, and the agent itself never holds repository credentials.
3. A human reviews the PR and merges it. Merge is the gate.
4. Every session refreshes the global clone (fast-forward when clean) and the plugin-managed sparse worktree from their remote default branches, then derives an index of titles and IDs from `memory/active/` in both stores and injects one section per store; full bodies load lazily on demand.

State is positional: `memory/active/` is shared truth, `memory/retired/` holds removed memories with a reason.

## Install

```bash
opencode plugin add @chncaesar/opencode-plugin-memory@latest
```

This plugin supports OpenCode 2.x only. See the [user guide](https://chncaesar.github.io/opencode-plugin-memory/) for manual config entries, local-clone installs, and all plugin options.

Global memory is optional. Create a private repository, clone it where the plugin expects it, and the next session finds it without a restart. The user guide above covers the folder layout.

## Development

```bash
npm install
npm run typecheck   # type-check only, no emit
npm run build       # compile to dist/
npm test            # compile + run unit tests (Node built-in runner)
```

Contributions are welcome through GitHub issues and pull requests. Run `npm test` before opening a PR.

## Links

- [User guide](https://chncaesar.github.io/opencode-plugin-memory/) (English)
- [Report an issue](https://github.com/chncaesar/opencode-plugin-memory/issues)