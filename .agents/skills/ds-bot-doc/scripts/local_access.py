#!/usr/bin/env python3
"""Enable, disable or inspect DS Bot Backdoor, the same-account administration socket."""

import argparse
import http.client
import json
import os
from pathlib import Path
import re
import socket
import stat
import sys
import tempfile
import time


class AccessError(Exception):
    pass


def private_directory(path, create=False):
    if create:
        path.mkdir(mode=0o700, parents=False, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise AccessError("unsafe_local_access_directory")


def private_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 4096):
            raise AccessError("unsafe_local_access_file")
        with os.fdopen(fd, encoding="utf8", closefd=False) as stream:
            value = json.load(stream)
        if not isinstance(value, dict):
            raise AccessError("invalid_local_access_file")
        return value
    finally:
        os.close(fd)


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout=20):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.sock.settimeout(self.timeout)
            self.sock.connect(self.socket_path)
        except BaseException:
            self.sock.close()
            self.sock = None
            raise


def socket_path(home, expected_pid=None):
    directory = Path(home) / "local-access"
    private_directory(directory)
    grant = private_json(directory / "access.json")
    if grant.get("version") != 1 or grant.get("enabled") is not True:
        raise AccessError("local_access_disabled")
    manifest = private_json(directory / "connection.json")
    pid = manifest.get("pid")
    if type(pid) is not int or pid <= 1 or manifest.get("version") != 1:
        raise AccessError("invalid_local_access_connection")
    with (Path(home) / "state.lock").open(encoding="utf8") as stream:
        writer_pid = json.load(stream).get("pid")
    if pid != writer_pid or (expected_pid is not None and pid != expected_pid):
        raise AccessError("local_access_writer_mismatch")
    root = Path(f"/tmp/ds-bot-operator-{os.getuid()}")
    private_directory(root)
    path = manifest.get("socket")
    if (not isinstance(path, str) or not re.fullmatch(
            re.escape(str(root)) + "/" + str(pid) + r"-[a-f0-9-]{36}\.sock", path)):
        raise AccessError("invalid_local_access_socket")
    info = Path(path).lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise AccessError("unsafe_local_access_socket")
    return path


def access_status(home, expected_pid=None):
    directory = Path(home) / "local-access"
    configured = False
    try:
        private_directory(directory)
        grant = private_json(directory / "access.json")
        configured = grant.get("version") == 1 and grant.get("enabled") is True
    except FileNotFoundError:
        pass
    value = {"enabled": configured, "active": False}
    if configured:
        try:
            conn = UnixConnection(socket_path(home, expected_pid), timeout=1)
            try:
                conn.request("GET", "/status")
                response = conn.getresponse()
                result = json.loads(response.read())
                value["active"] = response.status == 200 and result.get("ok") is True
                if value["active"]:
                    value["operations"] = result["value"]["operations"]
            finally:
                conn.close()
        except (OSError, ValueError, http.client.HTTPException, AccessError):
            pass
    return value


def set_access(home, enabled):
    directory = Path(home) / "local-access"
    private_directory(directory, create=True)
    target = directory / "access.json"
    if not enabled:
        target.unlink(missing_ok=True)
        return
    if target.exists() or target.is_symlink():
        private_json(target)
    temp = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf8", dir=directory, delete=False) as stream:
            temp = Path(stream.name)
            json.dump({"version": 1, "enabled": True}, stream)
        os.replace(temp, target)
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        "Default access is off. enable grants the current macOS account only the "
        "documented DS Bot operations; it exports no DSH login. Examples: "
        "local_access.py enable --desktop; local_access.py status --desktop; "
        "local_access.py disable --desktop"))
    parser.add_argument("action", choices=("enable", "disable", "status"))
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--desktop", action="store_true", help="Use the verified Dock-launched Desktop writer")
    target.add_argument("--team-home", type=Path, help="Explicit plugin team directory, for an isolated or Web host")
    args = parser.parse_args()
    try:
        expected_pid = None
        if args.desktop:
            from request import desktop_writer
            expected_pid = desktop_writer()
            home = Path.home() / ".dsh/bot"
        else:
            home = args.team_home.resolve(strict=True)
        if args.action != "status":
            set_access(home, args.action == "enable")
        result = access_status(home, expected_pid)
        if args.action == "enable":
            deadline = time.monotonic() + 3
            while not result["active"] and time.monotonic() < deadline:
                time.sleep(0.05)
                result = access_status(home, expected_pid)
            result["restartRequired"] = not result["active"]
        print(json.dumps({"ok": True, "value": result}))
        return 0
    except Exception as error:
        from request import RequestError
        code = str(error) if isinstance(error, (AccessError, RequestError)) else type(error).__name__
        print(json.dumps({"ok": False, "error": code}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
