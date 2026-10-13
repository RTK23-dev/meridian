"""Tests for the sourcing sidecar.

Run: python3 -m unittest discover -s sidecar/sourcing -p "test_*.py"  (needs sidecar/sourcing/requirements.txt)
"""

import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402

TOKEN = "test-token-0123456789abcdef"


class SidecarTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.httpd = server.make_server("127.0.0.1", 0, TOKEN)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def call(self, path: str, body, token: "str | None" = TOKEN) -> "tuple[int, dict]":
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(self.base + path, data=data, method="POST", headers={"Content-Type": "application/json"})
        if token is not None:
            request.add_header(server.TOKEN_HEADER, token)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"{}")

    def test_health_needs_no_token_and_names_the_parser(self) -> None:
        with urllib.request.urlopen(self.base + "/health", timeout=10) as response:
            body = json.loads(response.read())
        self.assertTrue(body["ok"])
        self.assertIn("scrapling", body["parser"])

    def test_every_post_needs_the_token(self) -> None:
        page = {"html": "<p>x</p>", "baseUrl": "https://example.com/"}
        self.assertEqual(self.call("/parse", page, token=None)[0], 401)
        self.assertEqual(self.call("/parse", page, token="wrong")[0], 401)

    def test_parse_drops_scripts_and_keeps_absolute_web_links_only(self) -> None:
        html = (
            "<html><head><title>Sand</title><script>secret()</script></head>"
            "<body><h1>Dries fast</h1><p>Two lines.</p>"
            '<a href="/shop">Shop</a><a href="javascript:void(0)">bad</a><a href="/shop">Shop again</a></body></html>'
        )
        status, body = self.call("/parse", {"html": html, "baseUrl": "https://example.com/page"})
        self.assertEqual(status, 200)
        self.assertEqual(body["title"], "Sand")
        self.assertNotIn("secret", body["text"])
        self.assertIn("Dries fast", body["text"])
        self.assertEqual(body["links"], [{"href": "https://example.com/shop", "text": "Shop"}])

    def test_parse_refuses_non_web_base_urls_and_missing_html(self) -> None:
        self.assertEqual(self.call("/parse", {"html": "<p>x</p>", "baseUrl": "file:///etc/passwd"})[0], 400)
        self.assertEqual(self.call("/parse", {"baseUrl": "https://example.com/"})[0], 400)

    def test_unknown_routes_and_non_object_bodies_are_refused(self) -> None:
        self.assertEqual(self.call("/fetch", {})[0], 404)
        self.assertEqual(self.call("/parse", b"[1, 2]")[0], 400)
        self.assertEqual(self.call("/parse", b"not json")[0], 500, "malformed JSON gives a generic error, with no payload echoed")

    def test_feed_parses_items_and_strips_markup_from_summaries(self) -> None:
        feed = (
            '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>'
            "<item><title>One</title><link>https://a.test/1</link><description>&lt;b&gt;Hi&lt;/b&gt; there</description></item>"
            "<item><title>Two</title><link>https://a.test/2</link><description>Second</description></item>"
            "</channel></rss>"
        )
        status, body = self.call("/feed", {"feed": feed, "limit": 1})
        self.assertEqual(status, 200)
        self.assertEqual(body["feedTitle"], "T")
        self.assertEqual(len(body["items"]), 1)
        self.assertEqual(body["items"][0]["summary"], "Hi there")

    def test_limits_and_node_names_are_checked(self) -> None:
        self.assertEqual(self.call("/feed", {"feed": "<rss/>", "limit": 0})[0], 400)
        self.assertEqual(self.call("/v2ex/hot", {"limit": 500})[0], 400)
        self.assertEqual(self.call("/v2ex/node", {"node": "../etc", "limit": 3})[0], 400)

    def test_the_server_refuses_other_hosts_and_short_tokens(self) -> None:
        with self.assertRaises(SystemExit):
            server.make_server("0.0.0.0", 0, TOKEN)
        with self.assertRaises(SystemExit):
            server.make_server("127.0.0.1", 0, "short")


if __name__ == "__main__":
    unittest.main()
