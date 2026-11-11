"""Frontend updates must replace cached assets even with unchanged timestamps."""

import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from core import config as app_config
from domains.frontend_assets import CONTENT_SECURITY_POLICY, assembled_html, versioned_html
from routers.frontend import RevalidatingStaticFiles, frontend_response


class FrontendAssetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "index.html").write_text(
            '<link href="/static/app.css"><script src="/static/app.js"></script>', encoding="utf-8",
        )
        (self.root / "app.css").write_text("body {color: red;}", encoding="utf-8")
        (self.root / "app.js").write_text("window.revision = 1;", encoding="utf-8")
        app = FastAPI()
        app.get("/")(lambda: frontend_response(self.root))
        app.mount("/static", RevalidatingStaticFiles(directory=self.root))
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_changed_content_gets_new_url_even_with_same_size_and_mtime(self):
        old_html = self.client.get("/")
        self.assertEqual(old_html.headers["cache-control"], "no-store")
        old_url = re.search(r'src="([^"]+)"', old_html.text).group(1)
        self.assertRegex(old_url, r"/static/app\.js\?v=[0-9a-f]{16}$")
        script = self.root / "app.js"
        before = script.stat()
        script.write_text("window.revision = 2;", encoding="utf-8")
        os.utime(script, ns=(before.st_atime_ns, before.st_mtime_ns))
        new_html = self.client.get("/")
        new_url = re.search(r'src="([^"]+)"', new_html.text).group(1)
        self.assertNotEqual(old_url, new_url)
        self.assertEqual(self.client.get(new_url).text, "window.revision = 2;")
        self.assertEqual(new_html.text, versioned_html(self.root))

    def test_unchanged_assets_reuse_their_digest(self):
        first = versioned_html(self.root)
        with patch("domains.frontend_assets.hashlib.sha256", wraps=hashlib.sha256) as sha256:
            self.assertEqual(versioned_html(self.root), first)
            sha256.assert_not_called()
            (self.root / "app.css").write_text("body {color: blue;}", encoding="utf-8")
            self.assertNotEqual(versioned_html(self.root), first)
            self.assertEqual(sha256.call_count, 1)

    def test_static_responses_revalidate_and_keep_conditional_requests(self):
        response = self.client.get("/static/app.css")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-cache")
        cached = self.client.get("/static/app.css", headers={"If-None-Match": response.headers["etag"]})
        self.assertEqual(cached.status_code, 304)
        self.assertEqual(cached.headers["cache-control"], "no-cache")

    def test_versioned_assets_are_immutable_and_invalid_versions_revalidate(self):
        html = self.client.get("/").text
        versioned_css_url = re.search(r'href="([^"]+)"', html).group(1)
        response = self.client.get(versioned_css_url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "public, max-age=31536000, immutable")

        cached = self.client.get(versioned_css_url, headers={"If-None-Match": response.headers["etag"]})
        self.assertEqual(cached.status_code, 304)
        self.assertEqual(cached.headers["cache-control"], "public, max-age=31536000, immutable")
        head = self.client.head(versioned_css_url)
        self.assertEqual(head.status_code, 200)
        self.assertEqual(head.headers["cache-control"], "public, max-age=31536000, immutable")

        invalid = self.client.get("/static/app.css?v=changed")
        self.assertEqual(invalid.headers["cache-control"], "no-cache")
        missing = self.client.get("/static/missing.css?v=0123456789abcdef")
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.headers["cache-control"], "no-cache")

        rejected = self.client.post(versioned_css_url)
        self.assertEqual(rejected.status_code, 405)
        self.assertEqual(rejected.headers["cache-control"], "no-cache")

    def test_pages_forbid_inline_scripts_through_content_security_policy(self):
        policy = self.client.get("/").headers["content-security-policy"]
        self.assertEqual(policy, CONTENT_SECURITY_POLICY)
        script_src = next(part for part in policy.split(";") if part.strip().startswith("script-src"))
        self.assertEqual(script_src.strip(), "script-src 'self'")
        self.assertIn("frame-ancestors 'none'", policy)

    def test_content_security_policy_forbids_inline_styles_and_data_images(self):
        policy = self.client.get("/").headers["content-security-policy"]
        directives = {part.split()[0]: part.split()[1:] for part in policy.split(";") if part.strip()}
        self.assertEqual(directives["style-src"], ["'self'"])
        self.assertEqual(directives["img-src"], ["'self'"])
        html = assembled_html(app_config.STATIC_DIR)
        self.assertNotRegex(html, r"(?i)<[^>]+\sstyle\s*=")
        self.assertNotIn("<style", html.lower())

    def test_real_pages_have_no_inline_scripts_or_event_handler_attributes(self):
        for name in ("index.html",):
            html = assembled_html(app_config.STATIC_DIR, name)
            self.assertNotRegex(html, r"\son[a-z]+\s*=\s*[\"']", name)
            self.assertNotRegex(html, r"<script(?![^>]*\bsrc=)[^>]*>", name)
            self.assertNotIn("javascript:", html, name)


class AssembledHtmlTests(unittest.TestCase):
    """`<!-- include: partials/<name>.html -->` lines are replaced by files in frontend/partials/."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.static = self.base / "static"
        self.partials = self.base / "frontend" / "partials"
        self.static.mkdir()
        self.partials.mkdir(parents=True)

    def site(self, index: str, **partials: str) -> Path:
        (self.static / "index.html").write_text(index, encoding="utf-8")
        for name, text in partials.items():
            (self.partials / f"{name}.html").write_text(text, encoding="utf-8")
        return self.static

    def test_include_replaces_the_whole_line(self):
        static = self.site("<body>\n    <!-- include: partials/a.html -->\n</body>\n", a="<p>A</p>\n")
        self.assertEqual(assembled_html(static), "<body>\n<p>A</p>\n</body>\n")

    def test_partial_can_include_another_partial_up_to_two_levels(self):
        static = self.site(
            "<!-- include: partials/a.html -->\n",
            a="<a>\n  <!-- include: partials/b.html -->\n</a>\n",
            b="<b></b>\n",
        )
        self.assertEqual(assembled_html(static), "<a>\n<b></b>\n</a>\n")

    def test_third_level_is_rejected(self):
        static = self.site(
            "<!-- include: partials/a.html -->\n",
            a="<!-- include: partials/b.html -->\n",
            b="<!-- include: partials/c.html -->\n",
            c="<c></c>\n",
        )
        with self.assertRaises(ValueError):
            assembled_html(static)

    def test_include_outside_partials_or_not_html_is_rejected(self):
        (self.base / "frontend" / "x.html").write_text("<x></x>\n", encoding="utf-8")
        (self.partials / "a.txt").write_text("<p>A</p>\n", encoding="utf-8")
        for reference in ("partials/../x.html", "../static/index.html", "partials/a.txt"):
            with self.subTest(reference=reference):
                static = self.site(f"<!-- include: {reference} -->\n")
                with self.assertRaises(ValueError):
                    assembled_html(static)

    def test_missing_partial_names_the_file(self):
        static = self.site("<!-- include: partials/ausente.html -->\n")
        with self.assertRaises(FileNotFoundError) as caught:
            assembled_html(static)
        self.assertIn("ausente.html", str(caught.exception))

    def test_versioned_html_versions_assets_referenced_only_in_a_partial(self):
        static = self.site("<!-- include: partials/a.html -->\n", a='<script src="/static/app.js"></script>\n')
        (static / "app.js").write_text("window.revision = 1;", encoding="utf-8")
        self.assertRegex(versioned_html(static), r'src="/static/app\.js\?v=[0-9a-f]{16}"')

    @unittest.skipUnless(shutil.which("node"), "node não está instalado")
    def test_node_and_python_assemble_the_same_page(self):
        node = subprocess.run(
            ["node", "tests/frontend/support/assembled-html.cjs"],
            cwd=app_config.BASE_DIR, capture_output=True, check=True,
        )
        self.assertEqual(node.stdout, assembled_html(app_config.STATIC_DIR).encode("utf-8"))

    @unittest.skipUnless(shutil.which("node"), "node não está instalado")
    def test_node_and_python_expand_nested_includes_the_same_way(self):
        files = {
            self.static / "index.html": "<body>\n  <!-- include: partials/a.html -->\n</body>\n",
            self.partials / "a.html": "  <a>\n    <!-- include: partials/b.html -->\n  </a>\n",
            self.partials / "b.html": "    <b>ç</b>\n",
        }
        for path, text in files.items():
            path.write_text(text, encoding="utf-8", newline="\n")
        node = subprocess.run(
            ["node", "tests/frontend/support/assembled-html.cjs", "index.html", str(self.static)],
            cwd=app_config.BASE_DIR, capture_output=True, check=True,
        )
        expected = "<body>\n  <a>\n    <b>ç</b>\n  </a>\n</body>\n"
        self.assertEqual(assembled_html(self.static), expected)
        self.assertEqual(node.stdout, expected.encode("utf-8"))


if __name__ == "__main__":
    unittest.main()
