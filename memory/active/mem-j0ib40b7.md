---
id: mem-j0ib40b7
title: opencode 镜像 ghcr.io/anomalyco/opencode:latest 是 V1 构建，V2 必须钉死 2.x 版本 tag
tags:
  - opencode
  - docker
  - deployment
  - gotcha
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-18T03:27:43.245Z
---
Anomalyco 的 OpenCode 容器镜像只发布在一个名字下：`ghcr.io/anomalyco/opencode`，V1 与 V2 共用该名字，靠 tag 区分。

- V2 发布流水线（`.github/release/publish-docker.sh`）只推送精确版本 tag（`docker://ghcr.io/anomalyco/opencode:$OPENCODE_VERSION`），不推 `latest`、不推 major/minor 浮动 tag。
- 实测（2026-11-18）：`latest` 的 OCI index digest 与 `1.19.6` 完全相同（sha256:de0dcdfb…，镜像 history 里是 `COPY dist/opencode-linux-x64-baseline-musl/bin/opencode`，没有 `opencode2` 软链），因此 `latest` 当前指向 1.x，不是 V2。`2.3.2` 的 digest 是另一个（sha256:be07cc4a…，history 里有 `COPY dist/cli-…` + `ln -s opencode opencode2`）。

适用场景：任何以为 `:latest` 就是最新 OpenCode 的部署脚本、compose 文件、K8s manifest。规则：部署/联调时必须显式写 `ghcr.io/anomalyco/opencode:<2.x.y>`，并在启动后确认 `GET /api/info` 返回的 version 是 2.x（V1 没有 `/api/info`，只有 `/global/health`，这是最快的行为区分点）。
