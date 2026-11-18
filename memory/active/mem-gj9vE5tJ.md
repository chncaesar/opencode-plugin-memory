---
id: mem-gj9vE5tJ
title: "channel_agent store: immutable/append-only tables need SQL triggers plus a dedicated writer, not the snapshot upsert"
tags:
  - channel_agent
  - sqlite
  - storage
  - immutability
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-18T12:11:54.496Z
---
In channel_agent (src/store.js), `#persist` writes every collection from the in-memory snapshot: it deletes rows missing from the snapshot and upserts every changed row. That model cannot express "immutable" or "append-only" by itself — any snapshot edit becomes an UPDATE, and any row dropped from the snapshot becomes a DELETE.

When adding a table that must never be rewritten (facts, provenance, audit rows), do both:
1. Enforce it in SQLite with triggers in the migration (BEFORE UPDATE with a WHEN clause naming every content column that may not change, and BEFORE DELETE raising ABORT). The one allowed mutation must be excluded from the WHEN clause — for facts that is only `superseded_by_version`.
2. If the primary key is composite, do not force it through the generic single-`key` COLLECTIONS machinery; write it in a dedicated append-only step at the end of `#persist` (`#persistProvenance`), guarded by the set of parent ids still in the snapshot.

Ordering also follows from COLLECTIONS: it is child-first for deletes and reversed for writes, so a new child table must be listed before its parent (a fact belongs before `initiative`), and anything with two parents is written last.

Evidence: the facts layer (schema v2) needed both a content-immutability trigger and a composite-key writer; a plain snapshot edit of `fact.body` is otherwise silently accepted.
