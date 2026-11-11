---
id: mem-MbK0H_RT
title: Memory titles in English — the bot copies them into PR titles
tags:
  - feedback
  - convention
  - memory-plugin
  - git
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-11T09:29:39.607Z
---
记忆条目的 `title` 必须用英文写。

原因：这个插件的机器人（bot）生成提交信息和 PR 标题时，直接取记忆的 title 拼接，例如 `memory: add <id> — <title>`。所以记忆标题用中文，产出的 PR 标题和提交信息就是中英混杂的。

用户明确要求 PR 一律用英文；全局 AGENTS.md 也规定提交信息和工程文档用英文。记忆条目属于工程文档，标题同样适用。

适用范围：所有通过记忆工具提交的条目，不论正文用什么语言。
