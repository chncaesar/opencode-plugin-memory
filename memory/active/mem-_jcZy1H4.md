---
id: mem-_jcZy1H4
title: Smoke-test the memory bot through the installed npm command, not only the compiled script
tags:
  - release
  - testing
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-19T06:44:23.170Z
---
When validating an npm release, install the tarball in an isolated directory and invoke the installed opencode-memory-bot command with --help. Assert that it prints usage, not just that it exits successfully. On POSIX, npm can expose the command as a symlink: Node may keep the symlink in argv[1] while resolving the ESM module URL to the target. A direct invocation can print usage while the installed command silently exits zero if the entry guard compares unresolved paths.
