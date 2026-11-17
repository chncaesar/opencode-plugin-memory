---
id: mem-AvrPV4CF
title: 补建旧版本 release 页：挂在已有 tag 上，完成后把最新版本重新标记为 Latest
tags:
  - release
  - github
  - workflow
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-17T09:12:27.672Z
---
补建历史版本 release 页时：

1. 用 `gh release create <tag> --verify-tag` 挂在**已存在**的 tag 上，不要把 tag 移到当前 main。已发 npm 的版本，tag 的代码树要和 npm 包内容一致；后续文档提交不影响 tag，但会让 tag 落后于 main——迁 tag 会造成 GitHub 源码与 npm 包不一致。
2. GitHub 的 "Latest" 是按 **release 创建时间**判定的，不是按版本号。补建旧版本会按发布时间倒序，最后创建的那个旧版本自动变成 Latest，把真正的最新版挤下去。
3. 所以补建顺序从旧到新，最后执行 `gh release edit <最新 tag> --latest` 显式恢复。
4. release 说明写"这次改了什么"（用户可感知的能力变化 + compare 链接），不要逐条抄提交信息。

例：opencode-plugin-memory 仓库补 v0.3.0/v0.4.0/v0.5.0 时，v0.5.0 创建后立刻变成 Latest，需要手动改回 v0.6.0。
