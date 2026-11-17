---
id: mem-VEMpI9h8
title: OpenCode expands {file:...}/{env:...} in plugin options first; a missing file arrives as an empty string
tags:
  - opencode
  - plugin
  - config
  - secrets
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-17T01:56:39.284Z
---
OpenCode resolves `{file:path}` and `{env:NAME}` references while loading the config, so a plugin that declares a `{file:...}` value in its options receives the **already-expanded content** — never the reference. Two consequences:

1. A plugin's own `{file:...}` resolver only fires on hosts that pass the reference through verbatim; treat it as a fallback, not the main path.
2. If the referenced file is missing or unreadable, the option arrives as an **empty string** (not an error, not the literal reference). A plugin that accepts "any string" will then call out with an empty credential and fail with a confusing provider error.

Rule: when validating a secret-bearing option, reject the empty string explicitly and name the field, so a missing key file surfaces as e.g. `"auditProvider" is missing apiKey` instead of an unauthenticated request. Verified on the opencode-plugin-memory audit: with the key file moved aside, the loaded plugin reported exactly that message while the other fields arrived intact; restoring the file made the same config parse fine.
