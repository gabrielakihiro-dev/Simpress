"""Path checks shared by the local inbox folders."""

from pathlib import Path


def is_link_or_junction(path: Path) -> bool:
    """True for symbolic links and NTFS junctions, which ``is_symlink`` alone misses.

    Generic reparse points are not rejected: OneDrive placeholders are reparse points too.
    """
    path = Path(path)
    is_junction = getattr(path, "is_junction", None)
    return path.is_symlink() or bool(is_junction and is_junction())
