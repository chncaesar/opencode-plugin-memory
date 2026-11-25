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
