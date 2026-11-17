---
id: mem-KP221qb2
title: OpenCode 2.x calls models through opencode.ai/inference; PAT/OAuth gets HTTP 400, so plugins need their own key
tags:
  - opencode
  - plugin
  - auth
  - inference-gateway
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-17T01:15:46.441Z
---
OpenCode 2.x (desktop) does not necessarily call a provider directly: the bundled CLI contains an inference proxy (`https://opencode.ai/inference/openai/v1`, `/anthropic/v1`, `/google/v1`, `/go/openai/v1`), so model calls are relayed through OpenCode's own gateway, which validates the credential as a "third-party user token". A PAT or account/OAuth credential there fails with:

    HTTP 400: checking third-party user token: bad request: Personal Access Tokens are not supported for this endpoint

This is a credential-TYPE rejection before billing, not quota exhaustion (quota shows up as 429/402 or "insufficient_quota").

Evidence and how to tell the same failure apart next time:
- The error string is NOT in the app binary, so it is a remote response body from that gateway, not client code.
- A direct call to `https://api.deepseek.com/chat/completions` with the machine's stored DeepSeek key returns 200, and with a bad key returns `401 Authentication Fails, Your api key ... is invalid`. So a "PAT not supported" 400 proves the request never reached DeepSeek directly.

Consequence for this plugin: background work (the audit) has no credential of its own; it asks the host to generate text, so it inherits whatever model+credential the host resolves, even when the plugin option names a model (e.g. `auditModel: deepseek/deepseek-flash`). Do not assume a provider's locally configured `apiKey` is what gets presented. If a background call must survive account-state changes, give it an explicit endpoint + apiKey of its own and call the provider directly, instead of relying on the host session/generate path.
