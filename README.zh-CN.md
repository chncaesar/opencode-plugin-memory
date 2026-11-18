# opencode-plugin-memory

**简体中文** | [English](README.md)

[![npm version](https://img.shields.io/npm/v/@chncaesar/opencode-plugin-memory)](https://www.npmjs.com/package/@chncaesar/opencode-plugin-memory)

给 [OpenCode](https://opencode.ai) 用的项目级持久记忆，以合并 PR 作为生效条件。LLM 只负责提出值得记住的知识，由人合并 pull request 之后，它才成为共享事实。不依赖云服务，不需要向量数据库。

> **完整使用手册（英文）：<https://chncaesar.github.io/opencode-plugin-memory/>**
> 安装方式、全部配置参数、机器人的用法、后台审计和故障排查都在手册里。该手册目前只有英文版。本 README 只讲最要紧的部分。

## 核心区别：只有合并才算批准

LLM 从不直接写入共享事实，它只能把一条提议写成文件，丢进本机、被 git 忽略的暂存目录。记忆只有在人合并 pull request 之后才有效，所以提议中的、错误的、有害的内容都不会悄悄变成共享事实。

## 工作方式

1. LLM 把一条记忆写成文件，放进 `.memory/staging/`。
2. 本机运行的机器人把每条提议在自己的分支上提交进 `memory/active/`，并开一个 pull request。所有 git 操作都在一个临时 worktree 里完成，agent 本身不持有仓库凭证。
3. 人审阅这个 PR 并合并。合并就是闸门。
4. 每个会话开始时，从 `memory/active/` 生成一份只有标题和编号的索引注入系统提示；正文按需懒加载。

状态由位置决定：`memory/active/` 是共享事实，`memory/retired/` 存放已移除的记忆，并附带原因。

## 安装

```bash
opencode plugin add @chncaesar/opencode-plugin-memory@latest
```

适用于 OpenCode 2.x。1.x 的配置键是单数（`plugin`）；两个版本使用的包名都是 `@chncaesar/opencode-plugin-memory`。改完要重启 OpenCode。手写配置、从本地目录加载、以及全部插件选项，见[使用手册](https://chncaesar.github.io/opencode-plugin-memory/)。

## 开发

```bash
npm install
npm run typecheck   # 只做类型检查，不产出文件
npm run build       # 编译到 dist/
npm test            # 编译并运行单元测试（Node 内置测试运行器）
```

欢迎通过 GitHub issue 和 pull request 参与。提交 PR 前先跑 `npm test`。

## 链接

- [使用手册](https://chncaesar.github.io/opencode-plugin-memory/)（英文）
- [项目仓库](https://github.com/chncaesar/opencode-plugin-memory)
- [问题反馈](https://github.com/chncaesar/opencode-plugin-memory/issues)
