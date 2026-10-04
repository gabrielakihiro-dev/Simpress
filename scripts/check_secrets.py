"""Lightweight repository guard for private keys and common credential formats."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from typing import Iterable, List, Tuple


PATTERNS: Tuple[Tuple[str, re.Pattern[str]], ...] = (
    ("private-key", re.compile(r"-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----")),
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("github-token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{50,})\b")),
    (
        "credential-assignment",
        re.compile(
            r"(?i)\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|password)\b"
            r"\s*[:=]\s*[\"']?([A-Za-z0-9/+_=.-]{24,})"
        ),
    ),
)


def scan_text(value: str) -> List[Tuple[int, str]]:
    findings = []
    for line_number, line in enumerate(value.splitlines(), start=1):
        for label, pattern in PATTERNS:
            if pattern.search(line):
                findings.append((line_number, label))
    return findings


def tracked_files(root: Path) -> Iterable[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=root,
        check=True,
        stdout=subprocess.PIPE,
    )
    for raw_path in result.stdout.split(b"\0"):
        if raw_path:
            yield root / Path(raw_path.decode("utf-8", errors="surrogateescape"))


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    issues = []
    for path in tracked_files(root):
        try:
            contents = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        for line_number, label in scan_text(contents):
            issues.append((path.relative_to(root), line_number, label))
    for relative_path, line_number, label in issues:
        print(f"{relative_path}:{line_number}: provável segredo ({label})")
    if issues:
        return 1
    print("Nenhum padrão de credencial conhecido foi encontrado nos arquivos Git rastreados.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
