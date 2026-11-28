"""SQLite JSON field codecs."""

import json
from typing import Any


def _json_text(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return "[]"


def _json_list(value: Any) -> list[str]:
    if isinstance(value, (list, tuple)):
        parsed = list(value)
    elif not value:
        return []
    else:
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed]


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}
