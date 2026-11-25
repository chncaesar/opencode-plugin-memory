# opencode-plugin-memory

**简体中文** | [English](README.md)

[![npm version](https://img.shields.io/npm/v/@chncaesar/opencode-plugin-memory)](https://www.npmjs.com/package/@chncaesar/opencode-plugin-memory)

给 [OpenCode](https://opencode.ai) 用的持久记忆，以合并 PR 作为生效条件：一份跟着你走进所有仓库的全局记忆，加上一份随仓库同行的项目记忆。LLM 只负责提出值得记住的知识，由人合并 pull request 之后，它才成为共享事实。不依赖云服务，不需要向量数据库。

> **完整使用手册（英文）：<https://chncaesar.github.io/opencode-plugin-memory/>**
> 安装方式、全部配置参数、机器人的用法、后台审计和故障排查都在手册里。该手册目前只有英文版。本 README 只讲最要紧的部分。

## 核心区别：只有合并才算批准

LLM 从不直接写入共享事实，它只能把一条提议写成文件，丢进本机、被 git 忽略的暂存目录。记忆只有在人合并 pull request 之后才有效，所以提议中的、错误的、有害的内容都不会悄悄变成共享事实。

## 两份记忆库

- **全局**——你自己的一份私有仓库，克隆在本机，注入每一个会话。大多数知识属于这里：工具和 API 的行为、基础设施、个人偏好、评审规则。
- **项目**——当前仓库 Git 中的 `memory/` 目录，凡是拿到这个仓库的人都能看到；运行时由插件维护的独立工作区从远端默认分支自动刷新，不触碰你当前开发中的分支和未提交改动。只放“只有这里才成立”的规则：它的架构、模块名、业务定义。

提议时会指明放进哪一份，克隆存在时默认进全局库；没有克隆时一切留在项目库，和以前一样。两份库各自暂存、各自发布、各自审计，一份出问题不会拖住另一份。提示里两段索引共用一份长度额度，项目段保留固定份额，所以全局库再大也挤不掉它。

## 什么样的知识才该记

只记工程产物说不清的东西：某个字段真正代表什么、为什么看起来最直接的做法是危险的、某条只划出禁止范围的边界。如果一条规则做完之后，代码、测试或设计文档会写明它，那就该写在那里——第二份副本会在下一次重构时飘掉。被记住的规则真正落地之后，就用 `implemented` 把它退休，合并请求里也会注明，让代码成为唯一的事实来源。

## 工作方式

1. LLM 把一条记忆写成文件，放进它所属那份库的 `.memory/staging/`——本机、被 git 忽略（全局克隆或插件托管的项目工作区内）。
2. 本机运行的机器人把每条提议在自己的分支上提交进 `memory/active/`，并在这个库所属的仓库里开 pull request：全局知识开在你的私有记忆仓库，项目知识开在项目仓库。发布用的 git 操作都在临时 worktree 里完成，agent 本身不持有仓库凭证。
3. 人审阅这个 PR 并合并。合并就是闸门。
4. 会话会从各自远端默认分支自动刷新全局克隆（工作树干净时快进）与插件托管的项目记忆工作区，并从两份库的 `memory/active/` 各生成一段只有标题和编号的索引注入系统提示；正文按需懒加载。

状态由位置决定：`memory/active/` 是共享事实，`memory/retired/` 存放已移除的记忆，并附带原因。

## 安装

```bash
opencode plugin add @chncaesar/opencode-plugin-memory@latest
```

本插件仅支持 OpenCode 2.x。手写配置、从本地目录加载和全部插件选项，请参阅[使用手册](https://chncaesar.github.io/opencode-plugin-memory/)。

全局库是可选的。建一份私有仓库，克隆到插件约定的位置，下一个会话就能找到，无需重启。具体目录结构见上面的使用手册。

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
- [问题反馈](https://github.com/chncaesar/opencode-plugin-memory/issues)
