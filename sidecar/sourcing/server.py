#!/usr/bin/env python3
"""Meridian's sourcing sidecar: parses pages and feeds that Meridian already fetched, and reads Agent Reach's public channels.

It never fetches a URL it was given. Node fetches every page under Meridian's robots and bot-check policy, then sends the HTML or
the feed text here. The only outbound calls are to fixed public V2EX API hosts. It has no challenge solver, no browser, no browser
fingerprint impersonation, no proxy and no cookies, and it does not read the cookies an operator stores for Agent Reach.

It listens on 127.0.0.1 only and needs MERIDIAN_SIDECAR_TOKEN (at least 24 characters). Every request except /health must send that
token in the X-Sidecar-Token header. Payloads and tracebacks are never written to the response or to the log.

Run: MERIDIAN_SIDECAR_TOKEN=... python3 sidecar/sourcing/server.py --port 8765
"""

import argparse
import hmac
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urljoin, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "vendor" / "scrapling"))
sys.path.insert(0, str(ROOT / "vendor" / "agent-reach"))

from scrapling.parser import Selector  # noqa: E402

MAX_BODY = 4 * 1024 * 1024
MAX_TEXT = 200_000
MAX_LINKS = 500
MAX_LIMIT = 50
TOKEN_HEADER = "X-Sidecar-Token"
NODE_NAME = re.compile(r"^[a-z0-9_-]{1,40}$")
NON_CONTENT_TAGS = ("script", "style", "noscript", "template", "svg", "iframe")
PARSER_VERSION = "scrapling 0.4.15"


class BadRequest(Exception):
    """A request the sidecar refuses, with a message that is safe to show."""


def clean(text: str) -> str:
    """Collapse runs of blank space, keeping paragraph breaks."""
    lines = [re.sub(r"[ \t\r\f\v]+", " ", line).strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line)


def require_html(payload: dict) -> tuple[str, str]:
    html = payload.get("html")
    base = payload.get("baseUrl")
    if not isinstance(html, str) or len(html.encode("utf-8")) > MAX_BODY:
        raise BadRequest("html is missing or too large")
    if not isinstance(base, str) or len(base) > 2000 or urlsplit(base).scheme not in ("http", "https"):
        raise BadRequest("baseUrl must be an http or https URL")
    return html, base


def parse_page(payload: dict) -> dict:
    html, base = require_html(payload)
    root = Selector(html, url=base)
    title = root.css("title")
    title_text = clean(title[0].get_all_text(strip=True, ignore_tags=NON_CONTENT_TAGS))[:300] if title else ""
    body = root.css("body")
    scope = body[0] if body else root
    text = clean(scope.get_all_text(separator="\n", strip=True, ignore_tags=NON_CONTENT_TAGS))[:MAX_TEXT]
    links: list[dict] = []
    seen: set[str] = set()
    for anchor in root.css("a[href]"):
        href = urljoin(base, (anchor.attrib.get("href") or "").strip())
        if urlsplit(href).scheme not in ("http", "https") or href in seen:
            continue
        seen.add(href)
        label = clean(anchor.get_all_text(separator=" ", strip=True, ignore_tags=NON_CONTENT_TAGS))[:200]
        links.append({"href": href, "text": label})
        if len(links) >= MAX_LINKS:
            break
    return {"title": title_text, "text": text, "links": links}


def strip_markup(fragment: str) -> str:
    return clean(Selector(fragment).get_all_text(separator=" ", strip=True, ignore_tags=NON_CONTENT_TAGS))[:1000]


def parse_feed(payload: dict) -> dict:
    feed = payload.get("feed")
    limit = payload.get("limit", 20)
    if not isinstance(feed, str) or len(feed.encode("utf-8")) > MAX_BODY:
        raise BadRequest("feed is missing or too large")
    if not isinstance(limit, int) or not 1 <= limit <= MAX_LIMIT:
        raise BadRequest(f"limit must be a whole number from 1 to {MAX_LIMIT}")
    import feedparser  # Agent Reach's RSS channel uses the same parser

    parsed = feedparser.parse(feed)
    items = []
    for entry in parsed.entries[:limit]:
        items.append({
            "title": clean(str(entry.get("title", "")))[:300],
            "link": str(entry.get("link", "")),
            "published": str(entry.get("published", "")),
            "summary": strip_markup(str(entry.get("summary", ""))),
        })
    return {"feedTitle": clean(str(parsed.feed.get("title", "")))[:300], "items": items}


def v2ex_topics(kind: str, payload: dict) -> dict:
    from agent_reach.channels.v2ex import V2EXChannel  # Agent Reach's V2EX channel, public API

    limit = payload.get("limit", 20)
    if not isinstance(limit, int) or not 1 <= limit <= MAX_LIMIT:
        raise BadRequest(f"limit must be a whole number from 1 to {MAX_LIMIT}")
    channel = V2EXChannel()
    if kind == "hot":
        topics = channel.get_hot_topics(limit=limit)
    else:
        node = payload.get("node")
        if not isinstance(node, str) or not NODE_NAME.match(node):
            raise BadRequest("node must be a V2EX node name of lowercase letters, digits, - or _")
        topics = channel.get_node_topics(node, limit=limit)
    items = []
    for topic in topics[:limit]:
        if not isinstance(topic, dict):
            continue
        items.append({
            "title": clean(str(topic.get("title", "")))[:300],
            "url": str(topic.get("url", "")),
            "replies": topic.get("replies") if isinstance(topic.get("replies"), int) else 0,
        })
    return {"items": items}


ROUTES = {
    "/parse": parse_page,
    "/feed": parse_feed,
    "/v2ex/hot": lambda payload: v2ex_topics("hot", payload),
    "/v2ex/node": lambda payload: v2ex_topics("node", payload),
}


class Handler(BaseHTTPRequestHandler):
    server_version = "MeridianSidecar/1"
    token = ""

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - the base class signature
        return  # Request lines can carry query data, so the sidecar keeps no access log.

    def _reply(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _authorised(self) -> bool:
        sent = self.headers.get(TOKEN_HEADER, "")
        return hmac.compare_digest(sent.encode("utf-8"), self.token.encode("utf-8"))

    def do_GET(self) -> None:
        if self.path == "/health":
            self._reply(200, {"ok": True, "parser": PARSER_VERSION, "routes": sorted(ROUTES)})
            return
        self._reply(404, {"error": "not found"})

    def do_POST(self) -> None:
        if not self._authorised():
            self._reply(401, {"error": "missing or wrong token"})
            return
        route = ROUTES.get(self.path)
        if route is None:
            self._reply(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._reply(400, {"error": "bad Content-Length"})
            return
        if length <= 0 or length > MAX_BODY:
            self._reply(413 if length > MAX_BODY else 400, {"error": "body is empty or too large"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise BadRequest("body must be a JSON object")
            self._reply(200, route(payload))
        except BadRequest as error:
            self._reply(400, {"error": str(error)})
        except Exception as error:  # Only the error type is logged, never the payload.
            sys.stderr.write(f"sidecar: {self.path} failed with {type(error).__name__}\n")
            self._reply(500, {"error": "internal error"})


def make_server(host: str, port: int, token: str) -> ThreadingHTTPServer:
    if host not in ("127.0.0.1", "localhost"):
        raise SystemExit("the sidecar listens on 127.0.0.1 only")
    if len(token) < 24:
        raise SystemExit("MERIDIAN_SIDECAR_TOKEN must be at least 24 characters")
    handler = type("BoundHandler", (Handler,), {"token": token})
    return ThreadingHTTPServer((host, port), handler)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Meridian sourcing sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    token = os.environ.get("MERIDIAN_SIDECAR_TOKEN", "")
    server = make_server(args.host, args.port, token)
    print(f"sourcing sidecar on http://{args.host}:{server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
