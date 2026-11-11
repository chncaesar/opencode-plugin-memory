---
id: mem-sFS76FPc
title: SQLite 字段命名：禁止用保留关键字（timestamp 等）
tags:
  - coding-style
  - sql
  - feedback
author: unknown
source: migrated from legacy MEMORY.md
proposed_at: 2026-09-07
approved_at: 2026-09-07
---
数据库字段命名不得使用 SQL 保留关键字，例如 timestamp、date、time、order、group、index 等。用业务语义命名代替：timestamp → created_at，date → record_date，等。这是用户明确纠正的规范，适用于所有 SQL schema 设计。
