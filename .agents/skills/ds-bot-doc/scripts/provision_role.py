#!/usr/bin/env python3
"""Apply a repository role profile or attach registered skills through the operator API."""

import argparse
import http.client
import json
import os
from pathlib import Path
import re
import sys

from request import Operator, RequestError


def profile_text(path, role):
    sections = re.split(r"^## (.+)$", path.read_text(encoding="utf8"), flags=re.MULTILINE)
    profiles = dict(zip(sections[1::2], sections[2::2]))
    if role not in profiles or not profiles[role].strip():
        raise RequestError("unknown_role_profile")
    return profiles[role].strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--bot-id", help="Update this existing Bot")
    target.add_argument("--ensure-name", help="Find this unique name or create it with --role")
    parser.add_argument("--role", help="Apply this heading from the role profiles to the role and instructions fields")
    parser.add_argument("--profiles", type=Path, default=Path("docs/bot-role-profiles.zh.md"))
    parser.add_argument("--skill", action="append", default=[], help="Attach an existing named skill (repeatable)")
    args = parser.parse_args()
    if not args.role and (args.ensure_name or not args.skill):
        parser.error("supply --role to create a Bot or --skill with an existing --bot-id")
    if args.ensure_name is not None:
        clean = args.ensure_name.strip()
        if not clean or clean != args.ensure_name or len(clean.encode("utf-16-le")) > 80:
            parser.error("--ensure-name must be a trimmed name within the Bot name length limit")
    base = os.getenv("DS_BOT_BASE_URL")
    if not base:
        parser.error("set DS_BOT_BASE_URL and an operator authentication source")
    try:
        instructions = profile_text(args.profiles, args.role) if args.role else None
        api = Operator(base, login_file=os.getenv("DS_BOT_LOGIN_FILE"),
                       cookie_jar=os.getenv("DS_BOT_COOKIE_JAR"), web_log=os.getenv("DS_BOT_WEB_LOG"))
        state = api.call("state", {})
        if state.get("readOnly") is not None:
            raise RequestError("bot/read-only")
        registered = {item["name"] for item in state["capabilities"] if item["kind"] == "skill"}
        wanted = list(dict.fromkeys(args.skill))
        if any(name not in registered for name in wanted):
            raise RequestError("register_requested_skills_first")
        key, value = ("id", args.bot_id) if args.bot_id else ("name", args.ensure_name)
        matches = [bot for bot in state["bots"] if bot[key] == value]
        if len(matches) > 1 or (not matches and args.bot_id):
            raise RequestError("target_not_unique_or_missing")
        fields = {"role": args.role, "instructions": instructions} if args.role else {}
        if not matches:
            bot = api.call("create-bot", {"name": args.ensure_name, **fields})
        else:
            bot = matches[0]
            if any(bot.get(k) != v for k, v in fields.items()):
                api.call("update-bot", {"id": bot["id"], **fields})
        for name in wanted:
            if name not in (bot.get("capabilities") or []):
                api.call("bot-capability", {"botId": bot["id"], "name": name, "attached": True})
        final = next((b for b in api.call("state", {})["bots"] if b["id"] == bot["id"]), None)
        if final is None or any(final.get(k) != v for k, v in fields.items()):
            raise RequestError("settings_readback_mismatch")
        if not set(wanted).issubset(final.get("capabilities") or []):
            raise RequestError("settings_readback_mismatch")
        print(json.dumps({"ok": True, "botId": bot["id"], "skillsVerified": wanted}, ensure_ascii=False))
    except (OSError, ValueError, http.client.HTTPException, RequestError) as error:
        code = str(error) if isinstance(error, RequestError) else type(error).__name__
        print(json.dumps({"ok": False, "error": code}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
