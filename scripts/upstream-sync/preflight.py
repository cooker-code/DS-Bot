#!/usr/bin/env python3
"""Read local dev, branches and worktree changes before an upstream sync."""
import argparse
import json
import subprocess
from pathlib import Path


def git(repo, *args):
    return subprocess.check_output(["git", "--no-optional-locks", "-C", str(repo), *args], text=True).rstrip("\n")


def ancestor(repo, commit, target):
    result = subprocess.run(
        ["git", "-C", str(repo), "merge-base", "--is-ancestor", commit, target],
        capture_output=True, text=True,
    )
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr.strip())
    return result.returncode == 0


def inspect(repo):
    root = Path(git(repo, "rev-parse", "--show-toplevel"))
    dev = git(root, "rev-parse", "--verify", "refs/heads/dev")
    branches = []
    refs = git(root, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads")
    for line in refs.splitlines():
        name, commit = line.split(" ", 1)
        included = ancestor(root, commit, dev)
        entry = {"branch": name, "head": commit, "includedInDev": included}
        if not included:
            patches = git(root, "cherry", dev, commit).splitlines()
            entry["commitsOutsideDev"] = int(git(root, "rev-list", "--count", f"{dev}..{commit}"))
            entry["patchesOutsideDev"] = sum(line.startswith("+ ") for line in patches)
        branches.append(entry)

    worktrees = []
    raw = git(root, "worktree", "list", "--porcelain", "-z")
    for record in raw.strip("\0").split("\0\0"):
        fields = dict(line.split(" ", 1) for line in record.split("\0") if " " in line)
        path = fields["worktree"]
        commit = fields["HEAD"]
        entry = {
            "path": path,
            "branch": fields.get("branch", "detached").removeprefix("refs/heads/"),
            "head": commit,
            "includedInDev": ancestor(root, commit, dev),
        }
        if Path(path).is_dir():
            entry["changes"] = git(path, "status", "--porcelain=v1").splitlines()
        else:
            entry["unavailable"] = True
        worktrees.append(entry)
    return {
        "workspace": str(root),
        "branch": git(root, "branch", "--show-current") or "detached",
        "head": git(root, "rev-parse", "HEAD"),
        "dev": dev,
        "branches": branches,
        "worktrees": worktrees,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    args = parser.parse_args()
    print(json.dumps(inspect(args.repo), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
