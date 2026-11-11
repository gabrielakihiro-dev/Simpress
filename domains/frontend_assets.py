"""Serve one coherent frontend revision after local Git updates."""

import hashlib
import re
import stat
import zlib
from pathlib import Path

# Pages wire events through data-on-* attributes (static/js/ui/action-dispatcher.js),
# so scripts never need 'unsafe-inline'. Styles come from CSS files only (no style= in the HTML);
# JS sets layout through the CSSOM (el.style.x), which style-src does not block.
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; "
    "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; "
    "frame-ancestors 'none'; form-action 'self'"
)

_LOCAL_ASSET = re.compile(r'''(\b(?:src|href)=["'])(/static/[^"'<>\s?#]+)(["'])''')

# Every page load re-checks each asset, but resolving paths and hashing dominate the cost.
# Resolved paths are kept per URL; a digest is reused while the file's mtime, size and CRC-32
# still match. The CRC-32 catches rewrites that keep size and mtime, which stat cannot see on Windows.
_resolved_assets: dict[tuple[Path, str], Path] = {}
_asset_digests: dict[Path, tuple[int, int, int, str]] = {}


def _resolve_asset(root: Path, url: str) -> Path | None:
    key = (root, url)
    asset = _resolved_assets.get(key)
    if asset is None:
        asset = (root / url.removeprefix("/static/")).resolve()
        if not asset.is_relative_to(root):
            return None
        _resolved_assets[key] = asset
    return asset


def _asset_digest(asset: Path) -> str | None:
    try:
        info = asset.stat()
        if not stat.S_ISREG(info.st_mode):
            return None
        content = asset.read_bytes()
    except OSError:
        return None
    signature = (info.st_mtime_ns, info.st_size, zlib.crc32(content))
    cached = _asset_digests.get(asset)
    if cached is not None and cached[:3] == signature:
        return cached[3]
    digest = hashlib.sha256(content).hexdigest()[:16]
    _asset_digests[asset] = (*signature, digest)
    return digest


# A line holding only `<!-- include: partials/<name>.html -->` is replaced by that file from
# frontend/partials/ (next to static/, so the fragments are never served on their own).
# The directive's newline goes with it; each partial keeps its own final newline.
# Same rule in tests/frontend/support/assembled-html.cjs.
_INCLUDE = re.compile(r"^[ \t]*<!-- include: (\S+) -->\n", re.MULTILINE)
_MAX_INCLUDE_DEPTH = 2


def partials_dir(static_dir: Path) -> Path:
    return static_dir.resolve().parent / "frontend" / "partials"


def assembled_html(static_dir: Path, name: str = "index.html") -> str:
    """The page as the browser receives it, before the asset versions are added."""
    root = static_dir.resolve()
    partials = partials_dir(root)

    def expand(source: str, depth: int) -> str:
        def include(match: re.Match[str]) -> str:
            reference = match.group(1)
            target = (partials.parent / reference).resolve()
            if not target.is_relative_to(partials) or target.suffix != ".html":
                raise ValueError(f"Include fora de frontend/partials: {reference}")
            if depth >= _MAX_INCLUDE_DEPTH:
                raise ValueError(f"Include com mais de {_MAX_INCLUDE_DEPTH} níveis: {reference}")
            try:
                text = target.read_text(encoding="utf-8")
            except FileNotFoundError as exc:
                raise FileNotFoundError(f"Partial ausente: frontend/{reference}") from exc
            return expand(text, depth + 1)

        return _INCLUDE.sub(include, source)

    return expand((root / name).read_text(encoding="utf-8"), 0)


def versioned_html(static_dir: Path, name: str = "index.html") -> str:
    root = static_dir.resolve()
    source = assembled_html(root, name)

    def version(match: re.Match[str]) -> str:
        prefix, url, suffix = match.groups()
        asset = _resolve_asset(root, url)
        digest = _asset_digest(asset) if asset else None
        if not digest:
            return match.group(0)
        return f"{prefix}{url}?v={digest}{suffix}"

    return _LOCAL_ASSET.sub(version, source)
