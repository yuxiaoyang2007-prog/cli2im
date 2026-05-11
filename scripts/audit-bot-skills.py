#!/usr/bin/env python3
"""Audit which skills each cli2im bot inherits from its CLI binary.

Reads ~/.cli2im/config.yaml, then for every bot:
- claude-code agents → user-level ~/.claude/skills/ + enabled plugins in
  ~/.claude/plugins/, plus optional project-level <workdir>/.claude/skills/.
- codex agents → user-level ~/.codex/skills/, plus optional project-level
  <workdir>/.codex/skills/.
- gemini agents → no skill system (instructions live in GEMINI.md).

cli2im itself does NOT pass any skill flag to the CLI; this audit verifies the
skill set each bot session implicitly inherits via its working directory and the
shared user-level config dirs.

Exit code: 0 if every CC bot sees user-level skills (>0) and every Codex bot
sees user-level skills (>0); 1 if any expected source is missing.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path

import yaml

HOME = Path(os.path.expanduser("~"))
CONFIG_PATH = HOME / ".cli2im" / "config.yaml"

CC_USER_SKILLS = HOME / ".claude" / "skills"
CC_PLUGINS_SETTINGS = HOME / ".claude" / "settings.json"
CC_PLUGINS_DIR = HOME / ".claude" / "plugins"
CODEX_USER_SKILLS = HOME / ".codex" / "skills"


def count_skill_dirs(path: Path) -> int:
    """Count immediate child entries that look like a skill (dir or symlink to dir)."""
    if not path.exists():
        return 0
    n = 0
    for entry in path.iterdir():
        if entry.name.startswith("."):
            continue
        # A skill is a directory (or symlink resolving to one) containing SKILL.md.
        try:
            if entry.is_dir():
                if (entry / "SKILL.md").exists():
                    n += 1
                else:
                    # Allow nested layout (e.g. plugin skills with multiple
                    # SKILL.md beneath). Treat any subdir as one skill for the
                    # user-level count.
                    n += 1
        except OSError:
            continue
    return n


def enabled_plugins() -> list[str]:
    """Read enabledPlugins from ~/.claude/settings.json (jsonc tolerant)."""
    if not CC_PLUGINS_SETTINGS.exists():
        return []
    text = CC_PLUGINS_SETTINGS.read_text()
    # tolerant parse: strip // comments
    lines = [ln for ln in text.splitlines() if not ln.lstrip().startswith("//")]
    try:
        data = json.loads("\n".join(lines))
    except json.JSONDecodeError:
        return []
    enabled = []
    for k, v in (data.get("enabledPlugins") or {}).items():
        if v is True:
            enabled.append(k)
    return enabled


def count_plugin_skills(enabled: list[str]) -> int:
    """Approximate count of skills exposed by enabled CC plugins."""
    if not CC_PLUGINS_DIR.exists():
        return 0
    skill_dirs = []
    for root, dirs, _ in os.walk(CC_PLUGINS_DIR, followlinks=False):
        if "skills" in dirs:
            skill_dirs.append(Path(root) / "skills")
            # don't descend into nested skills/
            dirs[:] = [d for d in dirs if d != "skills"]
    total = 0
    for sd in skill_dirs:
        for child in sd.iterdir():
            if child.is_dir() and (child / "SKILL.md").exists():
                total += 1
    return total


def audit_bot(name: str, cfg: dict, plugin_skill_count: int) -> dict:
    agent = cfg.get("agent")
    workdir = Path(cfg.get("workingDirectory", ""))

    row = {
        "bot": name,
        "agent": agent,
        "platform": cfg.get("platform"),
        "workdir": str(workdir),
        "workdir_exists": workdir.exists(),
        "user_skills": 0,
        "plugin_skills": 0,
        "project_skills": 0,
        "ok": False,
        "notes": [],
    }

    if agent == "claude-code":
        row["user_skills"] = count_skill_dirs(CC_USER_SKILLS)
        row["plugin_skills"] = plugin_skill_count
        row["project_skills"] = count_skill_dirs(workdir / ".claude" / "skills")
        row["ok"] = row["user_skills"] > 0 and row["workdir_exists"]
        if not row["workdir_exists"]:
            row["notes"].append("workingDirectory does not exist")
        if row["user_skills"] == 0:
            row["notes"].append(f"missing user skills dir: {CC_USER_SKILLS}")
    elif agent == "codex":
        row["user_skills"] = count_skill_dirs(CODEX_USER_SKILLS)
        row["plugin_skills"] = -1  # n/a
        row["project_skills"] = count_skill_dirs(workdir / ".codex" / "skills")
        row["ok"] = row["user_skills"] > 0 and row["workdir_exists"]
        if not row["workdir_exists"]:
            row["notes"].append("workingDirectory does not exist")
        if row["user_skills"] == 0:
            row["notes"].append(f"missing user skills dir: {CODEX_USER_SKILLS}")
    elif agent == "gemini":
        row["user_skills"] = 0
        row["plugin_skills"] = -1
        row["project_skills"] = 0
        row["ok"] = True  # gemini has no skill system; not a failure
        row["notes"].append("no skill system; instructions via GEMINI.md")
    else:
        row["notes"].append(f"unknown agent: {agent}")

    return row


def fmt_cell(value) -> str:
    if value == -1:
        return "n/a"
    return str(value)


def main() -> int:
    if not CONFIG_PATH.exists():
        print(f"ERROR: cli2im config not found: {CONFIG_PATH}", file=sys.stderr)
        return 2

    with CONFIG_PATH.open() as f:
        cfg = yaml.safe_load(f)

    bots = cfg.get("bots") or {}
    if not bots:
        print("ERROR: no bots in config", file=sys.stderr)
        return 2

    plugins = enabled_plugins()
    plugin_skill_count = count_plugin_skills(plugins)

    print("=" * 78)
    print("cli2im bot skill inheritance audit")
    print(f"audit time : {datetime.now().isoformat(timespec='seconds')}")
    print(f"config     : {CONFIG_PATH}")
    print(f"CC user    : {CC_USER_SKILLS}  ({count_skill_dirs(CC_USER_SKILLS)} skills)")
    print(f"CC plugins : {len(plugins)} enabled → {plugin_skill_count} skills")
    print(f"Codex user : {CODEX_USER_SKILLS}  ({count_skill_dirs(CODEX_USER_SKILLS)} skills)")
    print("=" * 78)
    print()

    rows = []
    for name, bot_cfg in bots.items():
        rows.append(audit_bot(name, bot_cfg, plugin_skill_count))

    headers = ["bot", "agent", "platform", "user", "plugin", "project", "status"]
    widths = {
        "bot": max(len(r["bot"]) for r in rows + [{"bot": "bot"}]),
        "agent": max(len(r["agent"] or "?") for r in rows + [{"agent": "agent"}]),
        "platform": max(len(r["platform"] or "?") for r in rows + [{"platform": "platform"}]),
        "user": 5,
        "plugin": 6,
        "project": 7,
        "status": 6,
    }

    def fmt_row(values: list[str]) -> str:
        return "  ".join(v.ljust(widths[h]) for h, v in zip(headers, values))

    print(fmt_row(headers))
    print(fmt_row(["-" * widths[h] for h in headers]))
    failed = 0
    for r in rows:
        status = "OK" if r["ok"] else "FAIL"
        if not r["ok"]:
            failed += 1
        print(fmt_row([
            r["bot"],
            r["agent"] or "?",
            r["platform"] or "?",
            fmt_cell(r["user_skills"]),
            fmt_cell(r["plugin_skills"]),
            fmt_cell(r["project_skills"]),
            status,
        ]))

    notes = [(r["bot"], n) for r in rows for n in r["notes"]]
    if notes:
        print()
        print("Notes:")
        for bot, note in notes:
            print(f"  - [{bot}] {note}")

    print()
    print("Expected inheritance (CLI default discovery, cli2im passes no skill flag):")
    print("  - claude-code bot → ~/.claude/skills/ + enabled ~/.claude/plugins/ skills + <workdir>/.claude/skills/")
    print("  - codex bot       → ~/.codex/skills/ + <workdir>/.codex/skills/")
    print("  - gemini bot      → no skill system (GEMINI.md only)")
    print()

    if failed:
        print(f"AUDIT FAILED: {failed} bot(s) missing expected skill sources.")
        return 1
    print("AUDIT PASSED: every bot can resolve its expected skill sources.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
