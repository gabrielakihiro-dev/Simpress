"""Version-pinned access to openpyxl internals used by preservation checks."""

from typing import Any, Iterable

import openpyxl


SUPPORTED_OPENPYXL_VERSION = "3.1.5"


def _check_version() -> None:
    if openpyxl.__version__ != SUPPORTED_OPENPYXL_VERSION:
        raise RuntimeError(
            "A camada de preservação Excel requer revisão para openpyxl "
            f"{openpyxl.__version__}; versão validada: {SUPPORTED_OPENPYXL_VERSION}."
        )


def stored_cells(worksheet: Any) -> Iterable[Any]:
    _check_version()
    return tuple(worksheet._cells.values())


def chart_count(worksheet: Any) -> int:
    _check_version()
    return len(worksheet._charts)


def image_count(worksheet: Any) -> int:
    _check_version()
    return len(worksheet._images)


def style_catalog(workbook: Any) -> tuple[str, ...]:
    _check_version()
    return tuple(repr(style) for style in workbook._cell_styles)


def named_style_catalog(workbook: Any) -> tuple[str, ...]:
    _check_version()
    return tuple(repr(style) for style in workbook._named_styles)


def conditional_formatting_rules(conditional_formatting: Any) -> Any:
    _check_version()
    return conditional_formatting._cf_rules
