---
title: Install
layout: default
parent: Getting started
nav_order: 2
---

To install the plugin in your global OpenCode configuration:

```bash
opencode plugin add @chncaesar/opencode-plugin-memory@latest
```

Alternatively, add it to the `plugins` array in your project or global `opencode.json`:

```json
{
  "plugins": ["@chncaesar/opencode-plugin-memory"]
}
```

Every option has a default, so the entry above is enough to start. [Configure the plugin]({% link configure.md %}) when you want to change how it behaves.

## Install the bot (optional)

Publishing needs no separate bot. Whenever proposals are waiting, the plugin tells the agent they have no pull request yet, and the agent opens them — you approve by merging. You need the bot on your `PATH` only when you want to retry a stuck proposal from a terminal, or run a watcher that keeps publishing in the background.

The recommended form needs no installation and is always current:

```bash
npx -p @chncaesar/opencode-plugin-memory@latest opencode-memory-bot once
```

If you would rather have the bot permanently on your `PATH`, install it globally — but **keep its version equal to the plugin's**:

```bash
npm install -g @chncaesar/opencode-plugin-memory@latest
```

The version matters. The bot locates a project's pending proposals through the same isolated project store the plugin uses. An older bot still looks for proposals inside your project folder, so it reports that nothing is staged while your proposals sit unseen — they never become pull requests. After upgrading the plugin, upgrade the bot too, or use the `npx` form above so the two can never drift apart.

## Upgrading

The plugin and the bot are two separate installations, and each is upgraded on its own. Do it in this order.

**1. The plugin.** Check what is outdated, then update:

```bash
opencode plugin check
opencode plugin update
```

`update` places the new version in the host's cache alongside the old one and leaves your configuration entry and its options untouched. Omit the target to update every outdated plugin, or name the package to update only this one. Restart OpenCode afterwards: a session that is already open keeps the copy it loaded, so the new version applies to the next one.

**2. The bot — only if you installed it globally.** Re-run its install so it cannot fall behind the plugin:

```bash
npm install -g @chncaesar/opencode-plugin-memory@latest
```

Updating the plugin never touches the bot, because it is not part of the plugin's install; its only job is to put `opencode-memory-bot` on your `PATH`. Skip this step entirely if you use the `npx` form, which resolves the current version on every run and cannot drift.
