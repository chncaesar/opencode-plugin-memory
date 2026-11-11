---
id: mem-MbK0H_RT
title: Memory entries must be entirely in English, title and body
tags:
  - feedback
  - convention
  - memory-plugin
  - git
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-11T09:29:39.607Z
---
A memory entry must be written entirely in English: the `title` **and** the content body.

## Why

The bot wraps a memory entry in a pull request, and the reviewer reads that PR. The entry's title becomes the PR title and the commit subject (`memory: add <id> — <title>`); the entry's file content is what the "Files changed" tab shows. A Chinese entry therefore produces a Chinese pull request no matter how the template is written.

The user requires all PRs in English, and the global AGENTS.md requires commit messages and engineering documents in English. A memory entry is an engineering document.

## Scope

Every entry submitted through the memory tools, in any repository. Do not assume the title alone is enough: translating only the title leaves the diff in Chinese and the PR still reads as Chinese.

## Not a rule about answers

This governs artifacts (memory entries, commit messages, PRs). Conversational replies to the user stay in Chinese unless the user asks otherwise.
