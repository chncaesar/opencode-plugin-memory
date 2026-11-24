---
id: mem-1NqIdj8h
title: git 报 Connection closed by 198.18.x:443 是本机代理 fake-ip，不是 GitHub 拒绝；修法是 GitHub SSH 改走 22 端口而非 ssh.github.com:443
tags:
  - networking
  - proxy
  - diagnosis
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-24T08:50:58.214Z
---
本机（macOS）出现 `git ls-remote` / `git push` 报 `Connection closed by 198.18.x.x port 443`、`Connection timed out during banner exchange` 或 `fatal: Could not read from remote repository` 时，先判断是代理链路问题，而不是 GitHub 拒绝、凭证失效或仓库权限。

- `198.18.0.0/15` 是 Clash 系客户端 TUN 模式借用的 fake-ip 保留段（RFC 2544）。域名被解析成 198.18.x，真实连接由代理节点建立，所以报错里的远端 IP 不是 GitHub。本机客户端是 iKuuuVPN（core 为 iKuuuVPNCore），配置 `enhancedMode=fake-ip`、DNS 监听 1053；MonoProxyMac 装着但没运行，不要按它排查。日志在 `~/Library/Application Support/org.ikuuu.vpn/logs/`。
- 判别方法：对比 HTTPS 与 SSH 两条路。`curl -m 8 -o /dev/null -s -w "%{http_code} %{remote_ip}\n" https://github.com` 与 `https://api.github.com` 若都返回 200，说明隧道整体正常，问题只在 SSH 那条规则上，换节点没用，别先去重连代理。
- 已确认的根因：`~/.ssh/config` 把 `Host github.com` 指向 `HostName ssh.github.com` + `Port 443`（早年绕防火墙的写法），该 443 流在本机隧道里会卡在 banner exchange；改回直连 `github.com` 的 22 端口后 `git ls-remote` 连续三次成功。端口 22 经过同一隧道是通的。
- 改完后注意 known_hosts：旧配置写入的是 `[ssh.github.com]:443` 条目，直连后按 `github.com` 匹配，已经存在的 `github.com` 条目即可，不要把 443 的条目当成主机密钥变更。
- 隧道仍有低概率瞬时超时（实测三次里一次），失败重试通常即过；连续失败才去怀疑节点。
