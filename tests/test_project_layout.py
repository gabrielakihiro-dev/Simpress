"""Exercise the real frontend routes and build inputs without operational data."""

import hashlib
import re
import unittest
from html.parser import HTMLParser
from urllib.parse import parse_qs, urlsplit

from fastapi.testclient import TestClient

import main
from core.config import BASE_DIR, STATIC_DIR


class AssetParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        url = attributes.get("src" if tag == "script" else "href", "")
        if tag in {"script", "link"} and url.startswith("/static/"):
            self.urls.append(url)


class ProjectLayoutTests(unittest.TestCase):
    def test_real_entry_routes_serve_versioned_existing_assets(self):
        client = TestClient(
            main.app, base_url=f"http://127.0.0.1:{main.SERVER_PORT}",
            client=("127.0.0.1", 1234),
        )
        self.addCleanup(client.close)
        for route in ("/",):
            with self.subTest(route=route):
                response = client.get(route)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["cache-control"], "no-store")
                parser = AssetParser()
                parser.feed(response.text)
                self.assertGreater(len(parser.urls), 3)
                for url in parser.urls:
                    parts = urlsplit(url)
                    asset = STATIC_DIR / parts.path.removeprefix("/static/")
                    self.assertTrue(asset.is_file(), url)
                    expected = hashlib.sha256(asset.read_bytes()).hexdigest()[:16]
                    self.assertEqual(parse_qs(parts.query).get("v"), [expected], url)
                    served = client.get(url)
                    self.assertEqual(served.status_code, 200, url)
                    self.assertEqual(served.content, asset.read_bytes(), url)
                    self.assertEqual(served.headers["cache-control"], "no-cache", url)

    def test_tailwind_source_paths_resolve_after_reorganization(self):
        source = STATIC_DIR / "styles/tailwind.input.css"
        text = source.read_text(encoding="utf-8")
        references = re.findall(r'@(?:source|config) "([^"]+)"', text)
        self.assertGreaterEqual(len(references), 5)
        for reference in references:
            with self.subTest(reference=reference):
                self.assertTrue((source.parent / reference).exists())
        self.assertEqual((source.parent / references[0]).resolve(), BASE_DIR / "config/tailwind.config.cjs")

    def test_documentation_links_resolve_from_each_new_folder(self):
        documents = [BASE_DIR / "README.md", *(BASE_DIR / "docs").rglob("*.md")]
        checked = 0
        for document in documents:
            for target in re.findall(r'\]\(([^)]+)\)', document.read_text(encoding="utf-8")):
                target = target.split("#", 1)[0]
                if not target or re.match(r"[a-z]+:", target) or target.startswith("<") or " " in target:
                    continue
                with self.subTest(document=document.relative_to(BASE_DIR), target=target):
                    self.assertTrue((document.parent / target).exists())
                checked += 1
        self.assertGreater(checked, 20)
