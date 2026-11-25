---
title: When a rule becomes a feature
layout: default
parent: Maintenance
nav_order: 2
---

A memory is for what the artifact cannot say. Before accepting a proposal, ask one forward-looking question: once this rule is done, will the code, the tests or the design doc state it?

- If it already does — the screen behaves that way, the schema enforces it, the design doc says it — close the proposal. Two copies of one rule drift apart at the next redesign.
- If it will, but it is not built yet, the rule belongs to the task list or the design doc, not to memory. Writing it down now guarantees a duplicate once it lands.
- If no artifact will ever state it — what a field really means, why an obvious approach is dangerous, a boundary that forbids something — that is exactly what memory is for.

When a remembered rule does get built, retire the memory and say why. The retirement reason `implemented` records that the rule graduated into the artifact; the pull request shows it as graduated so a reviewer sees the memory is leaving because the code took over, not because the rule stopped being true.
