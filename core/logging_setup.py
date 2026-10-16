"""Logging for the local server: console plus a rotating file kept outside Git."""

import hashlib
import logging
import traceback
from logging.handlers import RotatingFileHandler
from pathlib import Path

LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
LOG_FILE_NAME = "simpress.log"
LOG_FILE_MAX_BYTES = 2 * 1024 * 1024
LOG_FILE_BACKUPS = 5
_HANDLER_MARKER = "_simpress_handler"


class RedactingFormatter(logging.Formatter):
    """Keep stack frames and exception types, but drop exception messages.

    Messages from ``OSError`` carry absolute paths with the Windows user name, and
    validation errors may quote workbook cells, serial numbers or e-mails.
    """

    def formatException(self, ei) -> str:
        error_type, error, tb = ei
        frames = "".join(traceback.format_tb(tb)).rstrip()
        name = getattr(error_type, "__name__", "Exception")
        if not frames:
            return name
        return "\n".join(("Traceback (most recent call last):", frames, name))


def redact_reference(value) -> str:
    """Short stable token that lets logs correlate a serial or hostname without exposing it."""
    text = str(value or "").strip()
    if not text:
        return "-"
    return "ref-" + hashlib.sha256(text.encode("utf-8")).hexdigest()[:10]


def configure_logging(log_dir: Path, level: int = logging.INFO) -> Path:
    """Attach the application handlers to the root logger once and return the log file.

    Uvicorn configures only its own loggers, so without this the ``logger.info`` calls
    in ``domains/`` were dropped and warnings reached the console without a timestamp.
    A log folder that cannot be created leaves the console handler working.
    """
    root = logging.getLogger()
    root.setLevel(level)
    log_file = Path(log_dir) / LOG_FILE_NAME
    if any(getattr(handler, _HANDLER_MARKER, False) for handler in root.handlers):
        return log_file

    formatter = RedactingFormatter(LOG_FORMAT)
    handlers: list[logging.Handler] = [logging.StreamHandler()]
    file_error = None
    try:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(RotatingFileHandler(
            log_file,
            maxBytes=LOG_FILE_MAX_BYTES,
            backupCount=LOG_FILE_BACKUPS,
            encoding="utf-8",
            delay=True,
        ))
    except OSError as error:
        file_error = error
    for handler in handlers:
        handler.setFormatter(formatter)
        setattr(handler, _HANDLER_MARKER, True)
        root.addHandler(handler)
    if file_error is not None:
        logging.getLogger(__name__).warning(
            "Não foi possível preparar a pasta de logs (%s); usando somente o console.",
            type(file_error).__name__,
        )
    return log_file
