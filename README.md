# opencode-plugin-memory

[简体中文](README.zh-CN.md) | **English**

[![npm version](https://img.shields.io/npm/v/@chncaesar/opencode-plugin-memory)](https://www.npmjs.com/package/@chncaesar/opencode-plugin-memory)

PR-gated persistent memory for [OpenCode](https://opencode.ai): global knowledge that follows you into every repository, plus a per-repository store that travels with the project. The LLM proposes durable knowledge; a human approves it by merging a pull request before it becomes shared truth. No cloud dependency, no vector database.

> **Full user guide: <https://chncaesar.github.io/opencode-plugin-memory/>**
> Installation options, all configuration parameters, the bot, background audit, and troubleshooting live there. This README covers only the essentials.

## The core difference: merge is the only approval

The LLM never writes shared truth. It can only drop a proposal file into a machine-local, git-ignored staging folder. A memory is not valid until a human merges the pull request, so proposed, wrong, or harmful content never silently becomes shared truth.

## How it works

1. The LLM proposes a memory by writing one file to `.memory/staging/`.
2. A local bot commits each proposal into `memory/active/` on its own branch and opens a pull request. All git work happens in a throwaway worktree, and the agent itself never holds repository credentials.
3. A human reviews the PR and merges it. Merge is the gate.
4. Every session derives an index of titles and IDs from `memory/active/` and injects it into the system prompt; full bodies load lazily on demand.

State is positional: `memory/active/` is shared truth, `memory/retired/` holds removed memories with a reason.

## Install

```bash
opencode plugin add @chncaesar/opencode-plugin-memory@latest
```

This plugin supports OpenCode 2.x only. See the [user guide](https://chncaesar.github.io/opencode-plugin-memory/) for manual config entries, local-clone installs, and all plugin options.

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
