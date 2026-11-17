# opencode-plugin-memory

**简体中文** | [English](README.md)

[![npm version](https://img.shields.io/npm/v/@chncaesar/opencode-plugin-memory)](https://www.npmjs.com/package/@chncaesar/opencode-plugin-memory)

给 [OpenCode](https://opencode.ai) 用的项目级持久记忆，以合并 PR 作为生效条件。LLM 只负责提出值得记住的知识，由人合并 pull request 之后，它才成为共享事实。不依赖云服务，不需要向量数据库。

> **完整使用手册（英文）：<https://chncaesar.github.io/opencode-plugin-memory/>**
> 分步使用流程、全部配置参数、后台审计的设置、故障排查都在这份手册里。该手册目前只有英文版。本 README 只讲最要紧的部分。

## 工作方式

- 插件向 OpenCode 注册六个工具（`memory_propose`、`memory_update`、`memory_delete`、`memory_read`、`memory_review`、`memory_publish`），LLM 在每个会话中都可以调用。
- LLM **从不直接写入共享事实**。它只把提议写成一个文件，放进本机、且被 git 忽略的 `.memory/staging/` 目录。
- 本机运行的**机器人**（一个你自己启动的小命令行程序）监视 staging，为每条提议建分支、把文件提交进 `memory/active/`，然后开一个 pull request。
- 由**人**照清单审阅这个 PR 并合并。合并是唯一的批准方式。
- 每个会话开始时，从 `memory/active/` 生成一份索引注入系统提示：只有标题和编号，永远不含正文。正文按需通过 `memory_read` 懒加载，所以库可以一直增长而不会把每次请求撑大。

未被合并的记忆不算数。提议中的、错误的、有害的内容都不会悄悄变成共享事实。

## 存储布局

状态由位置决定——文件放在哪个目录，就是什么状态：

```
.memory/staging/mem-*.md    本机暂存目录，被 git 忽略，agent 写在这里
memory/active/mem-*.md      已合并的事实；唯一会被注入上下文的部分
memory/retired/mem-*.md     已移除的记忆，附带原因与来源
```

没有索引文件：提示里的索引在会话开始时从 `memory/active/` 现算，所以它不可能与已合并的内容不一致。每个文件都用 YAML frontmatter 自描述；编号随机生成（`mem-` 加 8 个 base64url 字符），不会撞号，因此多个分支可以同时新增记忆。

## 安装

插件同时注册了 OpenCode 2.x 的 `setup` 钩子和 1.x 的 `server` 钩子，所以同一个包两种版本都能用。但两个版本的配置键不一样，先确认自己的版本。

### OpenCode 2.x

一条命令完成安装并写入配置：

```bash
opencode plugin add @chncaesar/opencode-plugin-memory@latest
```

也可以手写在 `opencode.json` / `opencode.jsonc` 的 `plugins`（**复数**）数组里：

```jsonc
"plugins": ["@chncaesar/opencode-plugin-memory"]

// 从本地克隆目录加载
"plugins": ["./opencode-plugin-memory"]
```

### OpenCode 1.x

配置键是单数（`plugin`），数组里直接放模块名。npm 插件由 OpenCode 在启动时自行安装，不需要额外操作：

```jsonc
"plugin": ["@chncaesar/opencode-plugin-memory"]
```

改完要重启 OpenCode：插件是按服务进程加载的。

选项写在插件条目里——2.x 是 `options` 对象，1.x 是 `[包名, 选项]` 这样的两元素数组。详见下文「配置」。

## 配置

所有选项都可选，不写就用默认值。选项要放在插件条目内部，不要放在 OpenCode 配置的顶层；改完需要重启 OpenCode。

可用的选项有 `maxSummaryChars`、`enableLog`、`staleDays`、`backgroundAudit`、`auditIntervalMinutes`、`auditBatchChars`、`auditModel`、`auditProvider`。各选项的默认值、行为说明和完整示例见英文手册的[配置一节](https://chncaesar.github.io/opencode-plugin-memory/#configure-the-plugin)，其中另有一节专门讲[给审计单独配一个服务商](https://chncaesar.github.io/opencode-plugin-memory/#use-a-separate-audit-provider)。

## 机器人

LLM 自己就能通过无参数的 `memory_publish` 工具把机器人跑起来。这一步不需要用户批准，因为它只开 PR（真正的闸门是合并），而且所有 git 操作都在一个临时的 `git worktree` 里完成，不会碰你的工作区、分支和未提交的改动。一个锁文件（`.memory/bot.lock`）保证 `watch` 常驻进程和 `memory_publish` 不会同时运行。

```bash
npx -p @chncaesar/opencode-plugin-memory opencode-memory-bot once    # 处理一次暂存中的提议，然后退出
npx -p @chncaesar/opencode-plugin-memory opencode-memory-bot watch   # 常驻轮询（默认每 2 秒一次）
npx -p @chncaesar/opencode-plugin-memory opencode-memory-bot watch --interval 10000 --dir <path>   # 换轮询间隔／换项目目录
```

机器人是唯一持有仓库凭证、唯一执行 git 的组件。它是本机的常驻进程／命令行工具，而不是 GitHub Action——Action 跑在远端，永远看不到本机那个被 git 忽略的暂存目录。它通过已经登录好的 `gh` 命令开 PR。每条提议的几种结果、重试行为和失败汇报，见手册的[发布与审阅](https://chncaesar.github.io/opencode-plugin-memory/#3-publish-and-review)一节。

## LLM 什么时候会提议一条记忆？

系统提示和工具说明会引导 LLM 在以下情形调用 `memory_propose`：

- 用户说「记住这个」「保存下来」；
- 发现或确认了一条可复用的编码规则、项目约定，或某类反复出现的 bug 的教训；
- 用户纠正了 LLM 的沟通方式、推理方式、编辑方式、测试方式或协作方式；
- 某条记忆因为过时或冲突，需要修正、替换或删除。

没有限定范围的纠正和偏好，默认就是长期的——用户不需要特意说「记住这个」。仅适用于当前这次回答、当前任务或当前文件的指示不会被提议；提议之前，插件会在 active 和 staging 中查重。

## 从旧的单文件存储迁移

首次运行时，插件会把旧的 `.opencode/memory/MEMORY.md`（以及 `.agents/memory/MEMORY.md`）——也就是 `Active`/`Archived` + `MEM-NNN` + `nextSeq` 那一套格式——迁移成一条记忆一个文件，分别落到 `memory/active/` 和 `memory/retired/` 下。一个 `memory/.migration.json` 附属文件记录旧编号到新编号的映射，保证 `superseded_by` 链接能对上。迁移是幂等的，旧文件会原样留在原地作为备份，并且永远不会阻塞启动。

## 开发

```bash
npm install
npm run typecheck   # 只做类型检查，不产出文件
npm run build       # 编译到 dist/
npm test            # 编译并运行单元测试（Node 内置测试运行器）
```

欢迎通过 GitHub issue 和 pull request 参与。提交 PR 前先跑 `npm test`；下面这些设计约束是审阅时会看的。

## 设计说明

- **以合并为闸门**——记忆只有被合并后才有效；在人批准之前，任何提议都不被采信。
- **agent 不持有凭证**——agent 从不持有仓库凭证，也从不执行 git；它只写一个本地文件。
- **渐进加载**——提示里看到的是一份精简的标题索引，正文按需加载。
- **记忆的有效性与代码可回滚性无关**——记忆走自己的评审流程，从不掺进某个代码改动里。
- **不自动删除**——不会有定时清理；移除永远走 PR。
- **Zod 版本**——使用 `@opencode-ai/plugin` 提供的 `tool.schema`（zod 4），绝不直接 `import { z } from "zod"`。

## 延伸阅读

- [使用手册](https://chncaesar.github.io/opencode-plugin-memory/)（英文）
- [项目仓库](https://github.com/chncaesar/opencode-plugin-memory)
- [问题反馈](https://github.com/chncaesar/opencode-plugin-memory/issues)
