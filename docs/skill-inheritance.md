# Skill inheritance in cli2im bots

cli2im is a transparent launcher: when a Feishu/Telegram message arrives, it
spawns the configured CLI binary (`claude` / `codex` / `gemini`) inside the
bot's `workingDirectory` with a small set of plumbing flags (stream-json IO,
permission prompt, model). It passes **no skill-related arguments**. Every
skill a bot can call comes from the CLI binary's own discovery mechanism.

## What each bot can call

| Agent | User-level skills | Plugin skills | Project-level skills |
|---|---|---|---|
| `claude-code` | `~/.claude/skills/<name>/SKILL.md` | enabled plugins in `~/.claude/plugins/` (`prefix:skill`) | `<workingDirectory>/.claude/skills/<name>/` |
| `codex` | `~/.codex/skills/<name>/SKILL.md` | _none — Codex has no plugin system_ | `<workingDirectory>/.codex/skills/<name>/` |
| `gemini` | _no skill system_ | _none_ | `<workingDirectory>/GEMINI.md` is the only project-level hook |

Because cli2im does not isolate per-bot CLI state, all CC bots configured
against the same user account share the same user-level skills + the same
enabled plugins; all Codex bots likewise share the same user-level skills.
The only per-bot differentiation today comes from the `workingDirectory`
(project-level skills + project CLAUDE.md/AGENTS.md + project
`.claude/settings.json` hooks).

## Where to put a new skill

- **Visible to every CC bot:** drop the skill in
  `~/.claude/skills/<name>/SKILL.md`.
- **Only one CC bot:** create `<workingDirectory>/.claude/skills/<name>/SKILL.md`
  inside that bot's working directory.
- **Visible to every Codex bot:** drop the skill in
  `~/.codex/skills/<name>/SKILL.md`.
- **Only one Codex bot:** create `<workingDirectory>/.codex/skills/<name>/`.
- **Gemini bots:** there is no skill protocol; edit the bot's `GEMINI.md` or
  install a Gemini CLI extension.

## Verifying inheritance

Run the audit script:

```bash
python3 scripts/audit-bot-skills.py
```

The script reads `~/.cli2im/config.yaml`, enumerates each bot, and reports
how many user-level / plugin / project-level skills it would see. Exit code
`0` means every CC and Codex bot can resolve its expected skill sources.

Sample output (bot names are placeholders for whatever you have in your
config):

```
bot         agent        platform  user   plugin  project  status
----------  -----------  --------  -----  ------  -------  ------
cc-bot-a    claude-code  feishu    47     232     0        OK
cc-bot-b    claude-code  feishu    47     232     0        OK
codex-a     codex        feishu    24     n/a     0        OK
codex-b     codex        feishu    24     n/a     0        OK
gemini-a    gemini       feishu    0      n/a     0        OK
cc-bot-a    claude-code  telegram  47     232     0        OK
codex-a     codex        telegram  24     n/a     0        OK
gemini-a    gemini       telegram  0      n/a     0        OK
```

The `plugin` column counts SKILL.md files inside `~/.claude/plugins/` (both
enabled and cached) — it's a ceiling, not exactly what's invokable, because
disabled plugins still leave SKILL.md on disk. The Notes section in the
script output flags Gemini bots as "no skill system" by design (still `OK`).

## Why no symlinks / no per-bot config

Earlier drafts considered `<workdir>/.claude/skills → ~/.claude/skills`
symlinks to "make inheritance explicit". This is unnecessary and risky:

1. CC/Codex already merge user-level + project-level skills automatically.
2. A symlink would cause the same skill set to be discovered twice (once via
   user path, once via project path), leading to duplicate-load warnings or
   ambiguous resolution.

The implicit inheritance is the correct behaviour; this doc + the audit
script make it observable.
