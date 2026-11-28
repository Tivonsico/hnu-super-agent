"""保存群订阅。缺行时由 update_env_file 补上，不因为全新 .env 没有这两行而失败。"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Mapping, Sequence


def save_subscriptions(
    settings: Any,
    groups: Sequence[Any],
    aliases: Mapping[Any, Any],
    *,
    write: Callable[..., dict[str, Any]],
    private_ids: Sequence[str] | None = None,
) -> dict[str, Any]:
    selected = [str(item).strip() for item in groups if str(item).strip()]
    names = {str(key): str(value) for key, value in aliases.items() if str(key).strip()}
    env_path = Path(settings.env_file or Path.cwd() / ".env")
    updates = {
        "NOTICEHUB_GROUPS": ",".join(selected),
        "NOTICEHUB_GROUP_ALIASES": ",".join(key + "=" + value for key, value in names.items()),
    }
    if private_ids is not None:
        updates["NOTICEHUB_QQ_PRIVATE_IDS"] = ",".join(private_ids)
    result = write(env_path, updates)
    if not result.get("ok"):
        return {"ok": False, "groups": selected, "applied": False, "error": result.get("error") or ".env 写入失败"}
    settings.group_whitelist = tuple(selected)
    settings.group_aliases = names
    if private_ids is not None:
        settings.qq_private_ids = tuple(private_ids)
    return {"ok": True, "groups": selected, "applied": True}
