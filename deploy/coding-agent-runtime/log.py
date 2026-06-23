"""Structured JSON logging for the coding-agent runtime.

Single ``get_logger`` factory: one stdout ``StreamHandler`` per logger name
(idempotent), a whitelisting ``JsonFormatter``, and a ``redact`` helper that
masks secret-bearing keys. Stdlib only, no project imports — so the module
can be copied into a build context scoped to this directory.

Adapted from aws-samples/sample-agent-assisted-sdlc shared/log.py.
"""

from __future__ import annotations

import datetime as _datetime
import json
import logging
import os
import sys
from typing import Any, Mapping

SECRET_KEYS = frozenset(
    {"token", "private_key", "secret", "password", "api_key", "authorization"}
)

_RESERVED_RECORD_ATTRS = frozenset(
    {
        "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
        "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
        "created", "msecs", "relativeCreated", "thread", "threadName",
        "processName", "process", "asctime", "taskName", "message",
    }
)

_HANDLER_SENTINEL = "_cc_log_configured"


def redact(d: Mapping[str, Any]) -> dict:
    """Shallow copy of ``d`` with secret-bearing keys masked (case-insensitive)."""
    out: dict = {}
    for key, value in d.items():
        if isinstance(key, str) and key.lower() in SECRET_KEYS:
            out[key] = "***REDACTED***"
        else:
            out[key] = value
    return out


class JsonFormatter(logging.Formatter):
    """Format log records as a single-line JSON object on stdout."""

    def format(self, record: logging.LogRecord) -> str:
        ts = _datetime.datetime.fromtimestamp(record.created, tz=_datetime.timezone.utc)
        timestamp = ts.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ts.microsecond // 1000:03d}Z"

        payload: dict = {
            "timestamp": timestamp,
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key in _RESERVED_RECORD_ATTRS:
                continue
            payload[key] = value
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def get_logger(name: str) -> logging.Logger:
    """Return an idempotently-configured stdout JSON logger for ``name``."""
    logger = logging.getLogger(name)
    if getattr(logger, _HANDLER_SENTINEL, False):
        return logger

    level_name = os.environ.get("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())

    logger.handlers = [handler]
    logger.setLevel(level)
    logger.propagate = False
    setattr(logger, _HANDLER_SENTINEL, True)
    return logger
