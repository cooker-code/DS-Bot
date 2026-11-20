#!/usr/bin/env python3
"""Call the authenticated DS Bot operator API. Credentials stay in memory."""

import argparse
import http.client
import http.cookiejar
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request


class RequestError(Exception):
    pass


def origin(url):
    return url.scheme, url.hostname, url.port or (443 if url.scheme == "https" else 80)


def loopback(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def announced_login(stream, base, root):
    latest = None
    for line in stream:
        match = re.search(r"dsh web:\s+(https?://[^\s]+)", line)
        if match:
            url = urlsplit(match.group(1))
            if origin(url) == origin(base) and url.path.rstrip("/") == root.rstrip("/"):
                latest = url
    if latest is None:
        raise RequestError("no_login_announcement_for_this_base")
    return latest


class Operator:
    def __init__(self, base, login_file=None, cookie_jar=None, web_log=None, timeout=20):
        self.base = urlsplit(base)
        if (self.base.scheme not in ("http", "https") or not self.base.hostname
                or self.base.username is not None or self.base.password is not None
                or self.base.query or self.base.fragment):
            raise RequestError("invalid_base_url")
        if self.base.scheme == "http" and not loopback(self.base.hostname):
            raise RequestError("use_https_for_remote_hosts")
        self.root = self.base.path.rstrip("/") + "/"
        self.timeout = timeout
        self.cookie = ""
        if sum(bool(item) for item in (login_file, cookie_jar, web_log)) != 1:
            raise RequestError("choose_one_auth_source")
        if login_file or web_log:
            if web_log:
                with Path(web_log).open(encoding="utf8", errors="replace") as stream:
                    login = announced_login(stream, self.base, self.root)
            else:
                login = urlsplit(Path(login_file).read_text().strip())
            if (origin(login) != origin(self.base) or login.path not in (self.root, self.root.rstrip("/"))
                    or login.username is not None or login.password is not None or login.fragment
                    or not parse_qs(login.query).get("token")):
                raise RequestError("login_url_must_match_base")
            status, headers, _ = self.exchange("GET", self.root + "?" + login.query)
            if status not in (301, 302, 303, 307, 308):
                raise RequestError("login_http_" + str(status))
            self.cookie = "; ".join(v.split(";", 1)[0] for k, v in headers if k.lower() == "set-cookie")
        else:
            jar = http.cookiejar.MozillaCookieJar(str(cookie_jar))
            jar.load(ignore_discard=True)
            req = Request(self.base.geturl().rstrip("/") + "/api/bot")
            jar.add_cookie_header(req)
            self.cookie = req.get_header("Cookie", "")
        if not self.cookie:
            raise RequestError("no_matching_session_cookie")

    def exchange(self, method, path, data=None):
        cls = http.client.HTTPSConnection if self.base.scheme == "https" else http.client.HTTPConnection
        conn = cls(self.base.hostname, self.base.port, timeout=self.timeout)
        try:
            headers = {"Content-Type": "application/json"} if data is not None else {}
            if self.cookie:
                headers["Cookie"] = self.cookie
            conn.request(method, path, body=data, headers=headers)
            response = conn.getresponse()
            return response.status, response.getheaders(), response.read()
        finally:
            conn.close()

    def call(self, endpoint, payload):
        body = json.dumps({"endpoint": endpoint, "payload": payload}, ensure_ascii=False).encode()
        status, _, raw = self.exchange("POST", self.root + "api/bot", body)
        if status != 200:
            raise RequestError("http_" + str(status))
        result = json.loads(raw)
        if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
            raise RequestError("invalid_api_envelope")
        if not result["ok"]:
            detail = result.get("error")
            code = detail.get("code", "") if isinstance(detail, dict) else ""
            raise RequestError(code if isinstance(code, str) and re.fullmatch(r"[a-z][a-z0-9/-]{0,63}", code) else "api_error")
        return result.get("value")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("endpoint", help="Operation from the API reference")
    parser.add_argument("--base", default=os.getenv("DS_BOT_BASE_URL"), help="DSH Web base URL including any mount prefix")
    auth = parser.add_mutually_exclusive_group()
    auth.add_argument("--login-file", help="Private file containing the operator-issued DSH login URL")
    auth.add_argument("--cookie-jar", help="Existing operator-provided Netscape-format cookie jar for this host")
    auth.add_argument("--web-log", help="Operator's DSH Web startup output containing the login announcement for --base")
    parser.add_argument("--payload", help="JSON object from a file, or - for standard input (default {})")
    parser.add_argument("--jq", help="Print only this jq projection of value. Default prints a receipt")
    args = parser.parse_args()
    if not args.base:
        parser.error("set --base or DS_BOT_BASE_URL")
    sources = (args.login_file, args.cookie_jar, args.web_log)
    if not any(sources):
        sources = tuple(os.getenv(key) for key in ("DS_BOT_LOGIN_FILE", "DS_BOT_COOKIE_JAR", "DS_BOT_WEB_LOG"))
    if sum(bool(item) for item in sources) != 1:
        parser.error("supply exactly one operator authentication source")
    if args.jq and not shutil.which("jq"):
        parser.error("jq is required for --jq")
    try:
        if args.jq:
            # Compile before performing an operation with side effects.
            checked = subprocess.run(["jq", "-n", "empty | (" + args.jq + ")"], capture_output=True)
            if checked.returncode:
                parser.error("invalid jq projection")
        payload = {}
        if args.payload:
            try:
                raw = sys.stdin.read() if args.payload == "-" else Path(args.payload).read_text(encoding="utf8")
                payload = json.loads(raw)
            except (ValueError, OSError):
                parser.error("payload must be a readable UTF-8 JSON document")
        if not isinstance(payload, dict):
            parser.error("payload must be a JSON object")
        value = Operator(args.base, *sources).call(args.endpoint, payload)
        if args.jq:
            output = subprocess.run(["jq", "-c", args.jq], input=json.dumps(value).encode(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            if output.returncode:
                raise RequestError("request_succeeded_projection_failed")
            sys.stdout.buffer.write(output.stdout)
        else:
            print('{"ok":true}')
        return 0
    except (ValueError, OSError, http.client.HTTPException, RequestError) as error:
        # Exception messages can include URLs, user content or credential paths.
        code = str(error) if isinstance(error, RequestError) else type(error).__name__
        print(json.dumps({"ok": False, "error": code}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
