"""Serve one coherent frontend revision after local Git updates."""

import hashlib
import re
from pathlib import Path

# Pages wire events through data-on-* attributes (static/js/ui/action-dispatcher.js),
# so scripts never need 'unsafe-inline'. Inline styles stay allowed for Tailwind and JS layout.
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; "
    "frame-ancestors 'none'; form-action 'self'"
)

_LOCAL_ASSET = re.compile(r'''(\b(?:src|href)=["'])(/static/[^"'<>\s?#]+)(["'])''')


def versioned_html(static_dir: Path, name: str = "index.html") -> str:
    root = static_dir.resolve()
    source = (root / name).read_text(encoding="utf-8")

    def version(match: re.Match[str]) -> str:
        prefix, url, suffix = match.groups()
        asset = (root / url.removeprefix("/static/")).resolve()
        if not asset.is_relative_to(root) or not asset.is_file():
            return match.group(0)
        digest = hashlib.sha256(asset.read_bytes()).hexdigest()[:16]
        return f"{prefix}{url}?v={digest}{suffix}"

    return _LOCAL_ASSET.sub(version, source)
