---
id: mem--uCheqbp
title: 提交 OpenCode 生态页插件条目的四个硬性要求（标题前缀、模板五节、两个勾选、表格追加对齐）
tags:
  - opencode
  - distribution
  - promotion
  - pull-request
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-17T02:54:19.482Z
superseded_by: mem-olufvdM3
retired_at: 2026-11-28T03:47:31.025Z
retired_reason: superseded
---
往 OpenCode 官方生态页加插件条目时，有四个容易白忙的点，前三个会导致 PR 被机器人自动关闭（警告后 72 小时）。

**1. 文件位置会随站点重构迁移，别信旧路径。** 2026-11-10 起 V1 文档从 `packages/web` 迁到 `services/site`，正确路径是 `services/site/src/docs/v1/content/ecosystem.mdx`，旧路径返回 404。找不准位置时先按 `docs/ecosystem` 页面内容反查，或用 GitHub API 列该文件的最近提交确认。

**2. 插件表是按合并时间追加的，不是字母序。** 新条目加在表格最后一行之后即可，不存在“插到字母位置”的问题。表是两列 `Name | Description`，Name 是 `[包名](仓库链接)`，scoped 包名有先例（`@plannotator/opencode`）。列是空格填充对齐的，追加前先算现有列宽：新行的两个单元格若都不超过现有最宽值，就只需加一行，否则 prettier 会把整表重排，PR 里会出现一堆无关改动。

**3. 标题和模板是硬性校验。** 标题必须匹配 `(feat|fix|docs|chore|refactor|test)(scope):` 形式，如 `docs(ecosystem): add X to ecosystem plugins`；PR 正文必须保留 `### Issue for this PR`、`### What does this PR do?`、`### Type of change`、`### How did you verify your code works?`、`### Checklist` 五个小节，Type of change 至少勾一项，Checklist 至少勾两项（模板只有两项，等于两项都要勾），验证小节不能为空。文档类 PR 免于关联 issue 的检查。仓库明确警告：整段 AI 生成的长描述可能被忽略或关闭，正文要短、用自己的话。

**4. 描述要贴合既有语感。** 现有条目是一条短句、6–15 词、不复述仓库名、不带感叹号和营销词（例：`Persistent memory across sessions using Supermemory`）。

只改英文那个文件；`ja/`、`zh-cn/` 等翻译副本长期滞后且 PR 不会同步更新，跟着改反而增加冲突面。
