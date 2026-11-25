---
title: Configure
layout: default
parent: Getting started
nav_order: 3
---

All options are optional. If you do not specify them, the plugin uses the defaults below. Put options inside the plugin entry, not at the top level of your OpenCode configuration. Restart OpenCode after editing them.

For example, this OpenCode 2.x configuration keeps an operation log, checks memories at most once every 30 minutes, and uses a smaller audit batch:

```json
{
  "plugins": [
    {
      "package": "@chncaesar/opencode-plugin-memory",
      "options": {
        "enableLog": true,
        "auditIntervalMinutes": 30,
        "auditBatchChars": 100000
      }
    }
  ]
}
```

If you already have other OpenCode settings or plugins, add the entry to your existing configuration instead of replacing it.

| Option | Default | Purpose |
| --- | --- | --- |
| `maxSummaryChars` | `10000` | Maximum characters in the injected index of memory titles. The separate memory-writing policy is not included in this limit. |
| `enableLog` | `true` | Write an operation log to `.memory/plugin.log`. Set to `false` to disable it. |
| `staleDays` | `90` | Age in days after which `memory_review` lists an active memory as aging. This is informational; it does not retire memories. |
| `backgroundAudit` | `true` | Enable the model-assisted audit after sessions become idle. Set to `false` to disable it; proposals and manual review still work. |
| `auditIntervalMinutes` | `1` | Minimum number of minutes between background audit attempts. Increase it to run audits less frequently. |
| `auditBatchChars` | `400000` | Maximum characters of memory text per audit batch. Lower it when the audit model has a smaller context window. |
| `auditModel` | Host default | Select the host model for audits as `providerID/modelID`. Ignored when `auditProvider` is set. |
| `auditProvider` | Not configured | Use a separate OpenAI-compatible endpoint and credentials for audits instead of the host's model call. See [Use a separate audit provider](#use-a-separate-audit-provider). |
| `globalMemoryEnabled` | `true` | Enable the global store. Set to `false` to keep memory inside each project, as earlier versions did. |
| `globalMemoryPath` | `~/.local/share/opencode/memory` | Where the global store is cloned on this machine. A leading `~` is expanded. |
| `defaultScope` | `global` | Store used when a proposal does not name one. Falls back to `project` when the global store is unavailable, so a missing clone never blocks a proposal. |
| `globalIndexShare` | `0.7` | Share of `maxSummaryChars` the global index may use. The project index keeps at least the rest reserved, so a large global store cannot push project entries out of the prompt. Unused budget is shared back. |

An audit interval is a minimum, not a promise that an audit will run on a timer: the plugin also checks conditions such as whether the active memories have changed. Batch size is measured in characters, not tokens. The default assumes a large context window; leave room for the prompt and response when choosing a smaller value. Individual memories are not split, and related entries in different batches can still be missed.

For example, to turn off automatic audits in OpenCode 2.x while keeping the rest of the plugin available:

```json
{
  "plugins": [
    {
      "package": "@chncaesar/opencode-plugin-memory",
      "options": { "backgroundAudit": false }
    }
  ]
}
```

To select a configured host model instead, set `"auditModel": "providerID/modelID"` in `options`, replacing both parts with an actual provider and model available in your OpenCode setup.

## Use a separate audit provider

The audit can call an OpenAI-compatible endpoint with its own credentials instead of using the host's model call. This can help if the host's account credential is rejected by the audit endpoint, or if you want to separate audit usage from the main model's quota.

For OpenCode 2.x, add an `auditProvider` object to `options`:

```json
{
  "plugins": [
    {
      "package": "@chncaesar/opencode-plugin-memory",
      "options": {
        "auditProvider": {
          "baseUrl": "https://api.example.com",
          "apiKey": "{env:MEMORY_AUDIT_API_KEY}",
          "model": "your-model"
        }
      }
    }
  ]
}
```

Replace the endpoint and model with your provider's values, set the environment variable, and restart OpenCode. The endpoint must support OpenAI-compatible chat completions. A `{file:path}` key reference is also supported. Keep actual API keys out of committed configuration.

The `auditProvider` fields are:

| Field | Required | Purpose |
| --- | --- | --- |
| `baseUrl` | Yes | Provider's base URL. Use the base appropriate for its OpenAI-compatible chat completions API, such as a URL ending in `/v1` if required by that provider. |
| `apiKey` | Yes | API key, or a reference such as `{env:MEMORY_AUDIT_API_KEY}` or `{file:~/.secrets/audit-key}`. |
| `model` | Yes | Model identifier accepted by that provider. |
| `headers` | No | Object of additional HTTP request headers, for providers that require them. |

For example, add `"headers": { "X-Provider-Header": "value" }` inside `auditProvider` only when your provider requires it. A custom `Authorization` header replaces the bearer authorization generated from `apiKey`; it is not added alongside it. Treat authentication headers as secrets and do not commit them.

An explicit `auditProvider` takes precedence over `auditModel`. If the provider configuration is incomplete, the audit reports an error rather than silently switching credentials. For a model with a smaller context window, lower `auditBatchChars`.
