---
title: Background audit
layout: default
parent: Maintenance
nav_order: 2
---

By default, the plugin can audit active memories after a session becomes idle. It looks for possible duplicates, refinements, and contradictions. Audit findings become retirement proposals, not automatic changes; a person still reviews and merges the resulting pull requests.

Each store is audited on its own, with its own schedule and its own history, so a failed audit in one store never affects the other.

The audit can split a large collection into overlapping batches. This keeps individual model calls bounded, but it can miss a relationship between entries placed in different batches. Treat the findings as review suggestions, not a complete or infallible analysis.

The audit uses the host's model by default. To send audits to a separate OpenAI-compatible endpoint with its own credentials, configure `auditProvider` as described in [Use a separate audit provider]({{ site.baseurl }}{% link configure.md %}#use-a-separate-audit-provider).
