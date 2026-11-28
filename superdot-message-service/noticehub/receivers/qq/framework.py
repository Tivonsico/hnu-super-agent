from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.error import HTTPError


CONNECTION_HELP = "无法连接 Framework。请确认桌面 QQ 已打开，并在「设置 → QQ 接入」中检查端口和连接令牌。"


def request_error(error: Exception) -> str:
    if isinstance(error, HTTPError):
        if error.code in {401, 403}:
            return "Framework 拒绝了连接。请在「设置 → QQ 接入」中检查连接令牌。"
        if error.code in {404, 405, 501}:
            return "Framework 当前未提供所需的接口。请确认连接的是 Framework 的 OneBot HTTP 服务。"
    elif isinstance(error, OSError):
        return CONNECTION_HELP
    return "Framework 未能完成请求。请在「设置 → QQ 接入」中检查连接后重试。"


def local_connections() -> list[tuple[str, str]]:
    root = Path.home() / "Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/NapCat/config"
    custom = os.environ.get("NOTICEHUB_FRAMEWORK_CONFIG_DIR")
    if custom:
        root = Path(custom).expanduser()
    connections: list[tuple[str, str]] = []
    for file in sorted(root.glob("onebot11_*.json")):
        try:
            network = json.loads(file.read_text(encoding="utf-8-sig"))["network"]
            servers = network.get("httpServers", [])
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            continue
        for server in servers if isinstance(servers, list) else ():
            if not isinstance(server, dict) or server.get("enable") is not True:
                continue
            if server.get("host") not in {"127.0.0.1", "localhost", "0.0.0.0", "::", "::1", "", None}:
                continue
            port = server.get("port")
            token = server.get("token", "")
            if type(port) is not int or not 1 <= port <= 65535 or not isinstance(token, str):
                continue
            host = "[::1]" if server.get("host") == "::1" else "127.0.0.1"
            connection = (f"http://{host}:{port}", token)
            if connection not in connections:
                connections.append(connection)
    return connections
