---
id: mem-SzBaisvb
title: Metabase 卡片数量单位统一用万颗（÷10000 在 SQL 里做）
tags:
  - metabase
  - 单位
  - 万颗
  - 数量规范
author: unknown
source: migrated from legacy MEMORY.md
proposed_at: 2026-09-04
approved_at: 2026-09-04
retired_at: 2026-09-04
retired_reason: stale
---
DW 表存储颗粒数量以"颗"为单位（原始整数），Metabase 卡片显示时统一换算为万颗。

换算规则：
- 在 SQL/MBQL 里用 `qty / 10000.0` 换算，不改 DW 表存储单位
- 列标题写"万颗"（如 `SUM(real_qty) / 10000.0 AS "出货量(万颗)"`）

适用范围：所有涉及颗粒数量的卡片（出货量、库存量、订单量、缺口量等）。

具体例子：
- fact_backlog.order_qty → 显示为万颗 → `order_qty / 10000.0`
- fact_outstock.real_qty → 显示为万颗 → `real_qty / 10000.0`
- stk_inventory.base_qty → 显示为万颗 → `base_qty / 10000.0`
