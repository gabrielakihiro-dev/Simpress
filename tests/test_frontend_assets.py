"""Frontend updates must replace cached assets even with unchanged timestamps."""

import os
from pathlib import Path
import re
import tempfile
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from domains.frontend_assets import CONTENT_SECURITY_POLICY, versioned_html
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

    def test_static_responses_revalidate_and_keep_conditional_requests(self):
        response = self.client.get("/static/app.css")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-cache")
        cached = self.client.get("/static/app.css", headers={"If-None-Match": response.headers["etag"]})
        self.assertEqual(cached.status_code, 304)
        self.assertEqual(cached.headers["cache-control"], "no-cache")

    def test_pages_forbid_inline_scripts_through_content_security_policy(self):
        policy = self.client.get("/").headers["content-security-policy"]
        self.assertEqual(policy, CONTENT_SECURITY_POLICY)
        script_src = next(part for part in policy.split(";") if part.strip().startswith("script-src"))
        self.assertEqual(script_src.strip(), "script-src 'self'")
        self.assertIn("frame-ancestors 'none'", policy)

    def test_real_pages_have_no_inline_scripts_or_event_handler_attributes(self):
        static_dir = Path(__file__).resolve().parents[1] / "static"
        for name in ("index.html", "pages/login.html"):
            html = (static_dir / name).read_text(encoding="utf-8")
            self.assertNotRegex(html, r"\son[a-z]+\s*=\s*[\"']", name)
            self.assertNotRegex(html, r"<script(?![^>]*\bsrc=)[^>]*>", name)
            self.assertNotIn("javascript:", html, name)


if __name__ == "__main__":
    unittest.main()
