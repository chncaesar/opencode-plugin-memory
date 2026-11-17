---
id: mem-K_WkIN1I
title: OpenCode 2.x 用 plugins（复数）+ 对象式条目，1.x 用 plugin（单数）+ 元组；写安装说明必须区分
tags:
  - opencode
  - plugin
  - configuration
  - docs
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-17T01:26:53.123Z
---
写 OpenCode 插件的安装说明时，必须按版本区分配置键，否则用户照做会静默失效（配置键被忽略，不报错，用户只会认为插件没用）。

- **OpenCode 2.x**：顶层键是 `plugins`（复数）。数组元素可以是模块名字符串、本地目录路径，或对象 `{ "package": "<name>", "options": { ... } }`。CLI 是 `opencode plugin add <pkg>`，会直接写入配置；另有 `plugin list / check / update / remove`。
- **OpenCode 1.x**：顶层键是 `plugin`（单数），数组只接受平的模块名字符串；传插件选项用 `[package, { options }]` 元组。1.x 没有 `plugin add` 子命令（1.17.18 上是 `opencode plugin <module>`），npm 插件由 OpenCode 启动时自动安装并缓存，不需要手动 npm install。

判断依据：官方 V2 文档是 `https://opencode.ai/docs/plugins`，V1 是 `https://opencode.ai/v1/docs/plugins`（页头注明 "These are the docs for OpenCode V1"）。本项目 `src/index.ts` 同时导出 `setup`（V2 加载器）和 `server`（V1 加载器），所以同一个包两种版本都能用，文档只是配置键不同。
