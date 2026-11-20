#!/usr/bin/env python3
"""Check that every operator API dispatched by the plugin has one reference row."""

import argparse
from collections import Counter
from pathlib import Path
import re
import sys


def cases(source):
    return set(re.findall(r"""^\s*case\s+['"]([a-z][a-z0-9-]*)['"]\s*:""", source, re.M))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd(), help="DS Bot repository root (default: working directory)")
    args = parser.parse_args()
    skill = Path(__file__).resolve().parents[1]
    host = args.repo / "ds-bot/src/host"
    if not (host / "channel.js").is_file() or not (host / "computer/index.js").is_file():
        parser.error("point --repo at a DS Bot checkout containing the plugin source")
    channel = (host / "channel.js").read_text()
    computer = (host / "computer/index.js").read_text()
    routes = cases(channel.split("switch (endpoint)", 1)[1].split("rt.channelCall = handle", 1)[0])
    delegated = cases(computer.split("function computerEndpoint(endpoint, body)", 1)[1].split("default:", 1)[0])
    if not routes or not delegated or "rt.computerEndpoint(" not in channel:
        sys.exit("Cannot locate both dispatchers. Update the inventory reader.")
    routes.update("computer-" + case for case in delegated)
    catalog = Counter()
    for doc in sorted((skill / "references").glob("*-api.md")):
        for line in doc.read_text().splitlines():
            if line.startswith("| "):
                first_cell = line.split("|")[1]
                catalog.update(re.findall(r"`([a-z][a-z0-9-]*)`", first_cell))
    problems = {
        "undocumented": sorted(routes - catalog.keys()),
        "unregistered": sorted(catalog.keys() - routes),
        "duplicate": sorted(key for key, count in catalog.items() if count > 1),
    }
    if any(problems.values()):
        for label, names in problems.items():
            if names:
                print(label + ": " + ", ".join(names), file=sys.stderr)
        return 1
    print(f"{len(routes)} operator endpoints documented exactly once")
    return 0


if __name__ == "__main__":
    sys.exit(main())
