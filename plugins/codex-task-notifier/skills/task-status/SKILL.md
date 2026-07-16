---
name: task-status
description: Report the main Codex task's final state accurately before a turn stops.
---

# Task status protocol

For the main task only, call exactly one status tool before stopping:

- Call `mark_waiting` with `question` when the user must provide information, or `confirmation` when the user must confirm a choice.
- Call `mark_completed` only after the requested deliverable is genuinely finished and verified.

An approval request does not count as a final task status. Subagents must not call either status tool. If completion is uncertain, do not call `mark_completed`.
