# opencode-plugin-memory

**简体中文** | [English](README.md)

[![npm version](https://img.shields.io/npm/v/@chncaesar/opencode-plugin-memory)](https://www.npmjs.com/package/@chncaesar/opencode-plugin-memory)

给 [OpenCode](https://opencode.ai) 用的项目级持久记忆，以合并 PR 作为生效条件。LLM 只负责提出值得记住的知识，由人合并 pull request 之后，它才成为共享事实。不依赖云服务，不需要向量数据库。

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

没有索引文件：提示里的索引在会话开始时从 `memory/active/` 现算，所以它不可能与已合并的内容不一致。

每个文件用 YAML frontmatter 自描述（`id`、`title`、`author`、`source`、`proposed_at`、`approved_at`、`approved_by`、`supersedes` / `superseded_by`、`retired_at`、`retired_reason`、`related_pr`，暂存文件另有 `intent`）。编号是随机生成的（`mem-` 加 8 个 base64url 字符），不会撞号，因此多个分支可以同时新增记忆。

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

// 带选项（全部可选，完整清单见下面「配置」一节）
"plugins": [
  {
    "package": "@chncaesar/opencode-plugin-memory",
    "options": {
      "maxSummaryChars": 10000,
      "auditIntervalMinutes": 2,
      // 让审计用自己的端点和密钥，而不是借用宿主账号的凭证。
      // 任何 OpenAI 兼容的服务都可以。
      "auditProvider": {
        "baseUrl": "https://api.deepseek.com",
        "apiKey": "{file:~/.secrets/opencode/deepseek-api-key}",
        "model": "deepseek-flash"
      }
    }
  }
]
```

本地构建产物用同样的对象写法，把路径放在 `package` 里：

```jsonc
"plugins": [
  {
    "package": "./opencode-plugin-memory",
    "options": { "maxSummaryChars": 10000 }
  }
]
```

### OpenCode 1.x

配置键是单数（`plugin`），数组里直接放模块名。npm 插件由 OpenCode 在启动时自行安装，不需要额外操作：

```jsonc
"plugin": ["@chncaesar/opencode-plugin-memory"]

// 带选项（全部可选，名称与 2.x 的对象写法相同）
"plugin": [
  [
    "@chncaesar/opencode-plugin-memory",
    {
      "maxSummaryChars": 10000,
      "auditIntervalMinutes": 30,
      "auditProvider": {
        "baseUrl": "https://api.deepseek.com",
        "apiKey": "{file:~/.secrets/opencode/deepseek-api-key}",
        "model": "deepseek-flash"
      }
    }
  ]
]
```

改完要重启 OpenCode：插件是按服务进程加载的。

## 机器人

LLM 自己就能通过无参数的 `memory_publish` 工具把机器人跑起来。这一步不需要用户批准，因为它只开 PR（真正的闸门是合并），而且所有 git 操作都在一个临时的 `git worktree` 里完成，不会碰你的工作区、分支和未提交的改动。一个锁文件（`.memory/bot.lock`）保证 `watch` 常驻进程和 `memory_publish` 不会同时运行。

机器人是唯一持有仓库凭证、唯一执行 git 的组件。它是本机的常驻进程／命令行工具，而不是 GitHub Action——Action 跑在远端，永远看不到本机那个被 git 忽略的暂存目录。它通过已经登录好的 `gh` 命令开 PR。

```bash
npx opencode-memory-bot once                                  # 处理一次暂存中的提议，然后退出
npx opencode-memory-bot watch                                 # 常驻轮询（默认每 2 秒一次）
npx opencode-memory-bot watch --interval 10000 --dir <path>   # 换轮询间隔／换项目目录
```

从源码运行时用 `node dist/bot.js once`。机器人会：

- 读取每个暂存文件的 `intent`；
- `propose` → 建 `memory/<id>` 分支，把文件提交进 `memory/active/`（若有 `supersedes` 指向的记忆，同时移入 `memory/retired/` 并写上 `superseded_by`），推送、开 PR，然后删掉暂存文件；
- `retire` → 建 `memory/retire/<id>-<timestamp>` 分支（这条记忆的新增分支通常还在，需要区分），把 `memory/active/<id>` 移入 `memory/retired/` 并写入原因，推送、开 PR，然后删掉暂存文件。

每条提议最后落在四种结果之一，运行结束时会以计数形式汇报：

- **promoted**（已推送）——建了分支、提交、开 PR、删掉暂存文件；
- **recovered**（已恢复）——分支已经在远端了（之前某次运行推送完但没走到开 PR 就停了）：机器人找到已有的 PR，或者补开一个，然后删掉暂存文件。不会重复提交，也不会多出分支；
- **skipped**（已跳过）——某条 `retire` 提议的目标已不在 active 里，没有东西可移。这条暂存文件会被刻意保留，也就是说之后每次运行都会重试并再次汇报，直到有人手动删除；
- **failed**（失败）——git 或 `gh` 拒绝了；暂存文件留着等下次运行，且 `once` 会以非零状态退出。一次不会改动任何文件的 `propose` 也落在这里，因为 git 不允许空提交。

`regenerate` 作为空操作被接受，供仍在校验调用的旧 CI 任务使用。机器人不会空转：它按固定间隔扫一遍暂存目录，把失败留在原地。

## 渐进式上下文

进入系统提示的只有索引（每条 active 记忆一行 `[mem-XXXX] 标题`），并且受 `maxSummaryChars` 限制。到达上限时，模型拿到的是子集加一条提示，它可以调用 `memory_read` 读取某一条的全文，或调用 `memory_review` 列出全部。任何衍生物都不提交进仓库，所以没有 CI 步骤，也没有需要保持同步的生成文件。

## 配置

- `maxSummaryChars`（数字，默认 `10000`）——注入的标题索引所占的最大字符数。固定的写入规则另行注入。
- `enableLog`（布尔，默认 `true`）——把操作日志写到 `.memory/plugin.log`。
- `staleDays`（数字，默认 `90`）——超过这个天数的 active 记忆会在 `memory_review` 里被标为「老化」。仅作提示，不会因为天数为任何记忆执行移除。
- `backgroundAudit`（布尔，默认 `true`）——在会话空闲后运行由模型判断的语义审计：逐条比对 active 记忆，报告重复 / 应当细化 / 相互矛盾的发现，每一个都会变成一条移除提议（由机器人开成 PR）。模型调用发生在哪里取决于宿主和选项：1.x 上是受限的 `memory-audit` agent，2.x 上是宿主自己的无状态文本生成，或者在设置了 `auditProvider` 时发给下面指定的端点。
- `auditIntervalMinutes`（数字，默认 `1`）——两次后台审计之间的最小间隔分钟数。
- `auditBatchChars`（数字，默认 `400000`）——单次审计模型调用所包含的记忆文本最大字符数。默认值假设模型约 100 万 token、且大致一个字符一个 token（中文）；如果你的审计模型上下文窗口更小就调低，因为过长的提示会让审计失败。更大的库会被切成几批相关条目，批次之间重叠 3 条；单条记忆不会被劈开，但落在不同批次里的一对记忆仍可能被漏判。例如在插件选项中写 `"auditBatchChars": 100000`。
- `auditModel`（字符串，仅 2.x 宿主）——审计使用的模型，写作 `"providerID/modelID"`。不设则用宿主默认值（1.x 的审计 agent 优先用 `small_model`）。设置了 `auditProvider` 时此项被忽略。
- `auditProvider`（对象，默认无）——让审计直接用自己读取的密钥调用某个服务，而不是请宿主生成文本。端点需与 OpenAI 兼容（`/chat/completions`）：

  ```jsonc
  "auditProvider": {
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "{file:~/.secrets/opencode/deepseek-api-key}",
    "model": "deepseek-flash"
  }
  ```

  `apiKey` 可以是字面量、`{file:path}` 或 `{env:NAME}`——宿主会在插件看到选项**之前**就展开这些引用，只有当宿主把引用原样透传时插件才会自己再解析一次。因此密钥文件不存在时插件收到的是**空字符串**，它会以 `"auditProvider" is missing apiKey` 报错，而不是在未认证的情况下去调服务。可选的 `headers` 对象用于添加请求头，给那些不止需要 bearer token 的端点；合并时大小写不敏感，所以自定义的 `authorization` 会替换掉 bearer token，而不是与它并存。适用场景：宿主通过推理网关转发模型调用、而该网关以 `HTTP 400 … Personal Access Tokens are not supported for this endpoint` 拒绝账号凭证（这是凭证类型被拒，不是额度问题）；或者单纯想让审计不占主模型的额度。与其它可选项不同，**不完整的** `auditProvider` 会直接报错：审计会报告缺少哪个字段，而不是悄悄退回宿主的凭证。它在两种宿主上都优先于 `auditModel`。

## LLM 什么时候会提议一条记忆？

系统提示和工具说明会引导 LLM 在以下情形调用 `memory_propose`：

- 用户说「记住这个」「保存下来」；
- 发现一条可复用的编码规则或项目约定；
- 修掉了一类反复出现的 bug，教训值得留下；
- 用户纠正了 LLM 的沟通方式、推理方式、编辑方式、测试方式或协作方式；
- 用户确认某个并不显然的做法有效，希望以后照做；
- 某条记忆因为过时或冲突，需要修正、替换或删除。

没有限定范围的纠正和偏好，默认就是长期的——用户不需要特意说「记住这个」。仅适用于当前这次回答、当前任务或当前文件的指示则不会被提议。提议之前，插件会在 active 和 staging 中查重。

## 从旧的单文件存储迁移

首次运行时，插件会把旧的 `.opencode/memory/MEMORY.md`（以及 `.agents/memory/MEMORY.md`）——也就是 `Active`/`Archived` + `MEM-NNN` + `nextSeq` 那一套格式——迁移成一条记忆一个文件，分别落到 `memory/active/` 和 `memory/retired/` 下。一个 `memory/.migration.json` 附属文件记录旧编号到新编号的映射，保证 `superseded_by` 链接能对上。迁移是幂等的，旧文件会原样留在原地作为备份，并且永远不会阻塞启动。

## 开发

```bash
npm install
npm run typecheck   # 只做类型检查，不产出文件
npm run build       # 编译到 dist/
npm test            # 编译并运行单元测试（Node 内置测试运行器）
```

## 设计说明

- **以合并为闸门**——记忆只有被合并后才有效；在人批准之前，任何提议都不被采信。
- **agent 不持有凭证**——agent 从不持有仓库凭证，也从不执行 git；它只写一个本地文件。
- **渐进加载**——提示里看到的是一份精简的标题索引，正文按需加载。
- **记忆的有效性与代码可回滚性无关**——记忆走自己的评审流程，从不掺进某个代码改动里。
- **不自动删除**——不会有定时清理；移除永远走 PR。
- **Zod 版本**——使用 `@opencode-ai/plugin` 提供的 `tool.schema`（zod 4），绝不直接 `import { z } from "zod"`。
