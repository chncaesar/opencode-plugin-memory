---
id: mem-1NqIdj8h
title: git 报 Connection closed by 198.18.x:443 是本机代理 fake-ip 断开，不是 GitHub 拒绝；本机客户端是 iKuuuVPN
tags:
  - networking
  - proxy
  - diagnosis
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-24T08:50:58.214Z
---
本机（macOS）发生 `git`/`curl` 报 `Connection closed by 198.18.x.x port 443` 或 `fatal: Could not read from remote repository` 时，先判断是不是代理问题，而不是 GitHub 拒绝或凭证问题。

- `198.18.0.0/15` 是 Clash 系客户端 TUN 模式的 fake-ip 保留段（RFC 2544）。域名被解析成 198.18.x，真实连接由代理节点建立，所以报错里的远端 IP 不是 GitHub。
- 报错含义：本地 TUN 接受了连接，节点随后断开/重置。典型原因是 fake-ip 映射指向已失效的节点，或该站点的分流规则钉在死节点上。重连或换节点即可，不需要动凭证或 remote。
- 判别方法：`curl -m 6 -o /dev/null -s -w "%{http_code} %{remote_ip}\n" https://github.com`。若能通而 git 不通，同一域名拿到两个不同 198.18.x 就说明其中一条映射是坏的；`ifconfig` 里带 `198.18.0.1` 的 utun 和 `netstat -rn` 的 `128.0/1` 路由确认整机走 TUN。
- 当前这台机器的客户端是 iKuuuVPN（`/Applications/iKuuuVPN.app`，core 为 iKuuuVPNCore），配置 `enhancedMode=fake-ip`、DNS 监听 1053。MonoProxyMac 存在但没在跑，不要按 MonoProxyMac 去排查。日志在 `~/Library/Application Support/org.ikuuu.vpn/logs/`。
