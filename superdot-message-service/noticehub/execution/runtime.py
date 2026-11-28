"""Start one local DSH Web profile for SuperDot, shared by every ticket."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import tempfile
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener
from urllib.parse import urlsplit

PROJECT = Path(__file__).resolve().parents[2]
BUILD = PROJECT / "packaging" / "execution"
DEFAULT_PORT = 18765
LOCAL_HTTP = build_opener(ProxyHandler({}))


def runtime_directory() -> Path:
    base = Path.home() / ("Library/Application Support" if sys.platform == "darwin" else ".local/share")
    return Path(os.environ.get("SUPERDOT_RUNTIME_DIR") or base / "SuperDot/execution").expanduser().resolve()


def runtime_execution_token(runtime_dir=None):
    """Create a project-only bearer, atomically publishing a complete private file."""
    root = Path(runtime_dir).expanduser().resolve() if runtime_dir else runtime_directory()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = root / "execution.token"
    if not target.exists():
        fd, name = tempfile.mkstemp(dir=root)
        try:
            with os.fdopen(fd, "w") as handle:
                handle.write(secrets.token_urlsafe(32))
                handle.flush()
                os.fsync(handle.fileno())
            try:
                os.link(name, target)
            except FileExistsError:
                pass
        finally:
            os.unlink(name)
    return target.read_text().strip()


def _command():
    cli = os.environ.get("SUPERDOT_DSH_BIN") or shutil.which("dsh")
    if cli:
        return cli
    bundled = Path("/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh")
    if bundled.is_file():
        return str(bundled)
    raise RuntimeError("找不到 DSH Web 启动器。安装 DeepSeek Harness 或设置 SUPERDOT_DSH_BIN。")


def _prepare(root, message_url):
    package = PROJECT.parent / "execution-layer/exe-part/hnu-execution"
    dssa = PROJECT.parent / "dsh-superagent-prototype"
    for source in (package, dssa):
        if not (source / "src").is_dir():
            raise RuntimeError(f"缺少项目插件源码：{source}")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    tools = root / "plugins"
    tools.mkdir(exist_ok=True)
    lock = (BUILD / "package-lock.json").read_bytes()
    marker = tools / "installed.sha256"
    digest = hashlib.sha256(lock).hexdigest()
    if not marker.is_file() or marker.read_text() != digest or not (tools / "node_modules/.bin/esbuild").exists():
        for file in ("package.json", "package-lock.json"):
            shutil.copyfile(BUILD / file, tools / file)
        subprocess.run(["npm", "ci", "--no-fund", "--no-audit"], cwd=tools, check=True)
        marker.write_text(digest)
    esbuild = tools / "node_modules/.bin/esbuild"
    entries = [(package, "src/dsh/plugin.ts"), (dssa, "src/index.ts")]
    for source, entry in entries:
        output = tools / source.name / "lib/plugin.mjs"
        output.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([str(esbuild), str(source / entry), "--bundle", "--platform=node", "--target=node24",
                        "--format=esm", "--packages=external", "--log-level=warning", "--outfile=" + str(output)], check=True)
        for name in ("prompts", "skills", "locale"):
            if (source / name).is_dir():
                shutil.copytree(source / name, output.parent.parent / name, dirs_exist_ok=True)
        shutil.copyfile(source / "package.json", output.parent.parent / "package.json")

    hnu_manifest_path = tools / package.name / "package.json"
    manifest = json.loads(hnu_manifest_path.read_text())
    manifest["exports"] = {".": "./lib/plugin.mjs", "./client": "./lib/client.js", "./package.json": "./package.json"}
    manifest["dsh"] = {"manifestVersion": 1, "client": {"platform": "web", "inject": [
        "@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-ui-workspace",
    ]}}
    hnu_manifest_path.write_text(json.dumps(manifest))
    shutil.copyfile(package / "src/dsh/workbench-client.js", tools / package.name / "lib/client.js")
    subprocess.run(["node", str(BUILD / "build-client.mjs"), str(tools), str(dssa),
                    str(tools / dssa.name / "lib/client.js")], check=True)

    # Keep DSSA's own Router/Worker role definitions. The project consumes local message
    # packages, so does not start DSSA's GitHub or Feishu source watchers.
    template = (dssa / "cordis.patch.yml").read_text()
    presets = template[template.index("    - id: dsh-superagent-worker-preset"):]
    p = lambda path: json.dumps(str(path), ensure_ascii=False)
    directory = root / "superdot"
    directory.mkdir(exist_ok=True)
    session_dir = root / "dsh/sessions"
    session_dir.mkdir(parents=True, exist_ok=True)
    # Register the linked project bundles in the DSH profile itself so its Plugins
    # panel can inspect them and the sidebar uses the same installed packages.
    profile = root / "dsh/profiles/web"
    manifest_path = profile / "package.json"
    if not manifest_path.is_file():
        subprocess.run([_command(), "web", "--dump-config"], env={**os.environ, "DSH_HOME": str(root / "dsh")},
                       stdout=subprocess.DEVNULL, check=True)
    profile_manifest = json.loads(manifest_path.read_text())
    modules = profile / "node_modules"
    modules.mkdir(exist_ok=True)
    for source, block in [
        (dssa, f"    - id: dsh-superagent\n      name: dsh-superagent\n      config:\n        stateDir: {p(root / 'dssa')}\n" + presets),
        (package, f"    - id: hnu-execution\n      name: hnu-execution\n      config:\n        superdot: {p(directory)}\n        messageServiceUrl: {p(message_url)}\n"),
    ]:
        destination = tools / source.name
        manifest_file = destination / "package.json"
        pkg = json.loads(manifest_file.read_text())
        name = pkg["name"]
        pkg["exports"]["."] = "./lib/plugin.mjs"
        pkg["dsh"]["bundle"] = {"patch": "./project.patch.yml"}
        (destination / "project.patch.yml").write_text("- insert:\n" + block)
        manifest_file.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + "\n")
        link = modules / name
        if not link.exists():
            link.symlink_to(destination, target_is_directory=True)
        if link.resolve() != destination:
            raise RuntimeError(f"DSH profile 已存在其他来源的 {name}")
        dependencies = profile_manifest.setdefault("dependencies", {})
        bundles = profile_manifest["dsh"]["profile"]["bundles"]
        if name not in dependencies and name not in bundles:
            bundles.append(name)
        dependencies[name] = "link:" + str(destination)
    profile_manifest_tmp = manifest_path.with_suffix(".json.tmp")
    profile_manifest_tmp.write_text(json.dumps(profile_manifest, ensure_ascii=False, indent=2) + "\n")
    profile_manifest_tmp.replace(manifest_path)
    patch = root / "execution.patch.yml"
    patch.write_text(f"- id: session-persistence-jsonl\n  config:\n    root: {p(session_dir)}\n    compression: none\n")
    return patch


def _save_callback_token(root, token):
    # The Web service may rotate its own token while the shared host continues
    # serving active Worker sessions. Publish a private, complete replacement.
    fd, name = tempfile.mkstemp(dir=root)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(token)
        os.replace(name, root / "callback.token")
    finally:
        Path(name).unlink(missing_ok=True)


def _identity(url, expected):
    try:
        with LOCAL_HTTP.open(url + "/superdot-runtime", timeout=1) as response:
            return json.load(response) == expected
    except (OSError, ValueError, URLError):
        return False


def ensure_execution_runtime(runtime_dir=None, *, message_url, port=DEFAULT_PORT, execution_token=None, web_token=None):
    """Return a ready loopback execution host. Never attach to an unrelated listener."""
    parsed = urlsplit(message_url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or parsed.path not in {"", "/"} or parsed.username or parsed.query or parsed.fragment:
        raise ValueError("消息服务必须使用本机 HTTP 源地址")
    message_url = message_url.rstrip("/")
    if not (0 < port < 65536):
        raise ValueError("DSH 端口无效")
    root = Path(runtime_dir).expanduser().resolve() if runtime_dir else runtime_directory()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    url = f"http://127.0.0.1:{port}"
    expected = {"id": hashlib.sha256(str(root).encode()).hexdigest(), "messageServiceUrl": message_url}
    if web_token is not None or not (root / "callback.token").exists():
        _save_callback_token(root, web_token or os.environ.get("NOTICEHUB_WEB_TOKEN", ""))
    from main import acquire_lock

    deadline = time.monotonic() + 150
    while True:
        if _identity(url, expected):
            return url
        lock = acquire_lock(root / "startup.lock")
        if lock:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("等待共享 DSH 启动超时")
        time.sleep(.2)
    try:
        if _identity(url, expected):
            return url
        with socket.socket() as sock:
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                raise RuntimeError(f"端口 {port} 已由其他进程或其他项目使用")
        cli = _command()
        patch = _prepare(root, message_url)
        env = {k: v for k,v in os.environ.items() if k in
               ("HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SystemRoot", "USERPROFILE")}
        env.update(DSH_HOME=str(root / "dsh"), SUPERDOT_RUNTIME_ID=expected["id"],
                   SUPERDOT_CALLBACK_TOKEN_FILE=str(root / "callback.token"))
        endpoint_file = root / "model-endpoint.txt"
        if endpoint_file.is_file():
            endpoint = endpoint_file.read_text().strip()
            if urlsplit(endpoint).scheme not in {"https", "http"}:
                raise ValueError("模型服务地址必须使用 HTTP(S)")
            env["DEEPSEEK_BASE_URL"] = endpoint
        execution_token = execution_token or os.environ.get("NOTICEHUB_EXECUTION_TOKEN") or runtime_execution_token(root)
        for key, value in (("NOTICEHUB_EXECUTION_TOKEN", execution_token), ("NOTICEHUB_WEB_TOKEN", web_token)):
            if value is None:
                value = os.environ.get(key)
            if value:
                env[key] = value
        log = root / "host.log"
        with open(os.open(log, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600), "ab") as output:
            process = subprocess.Popen([cli, "web", "--patch", str(patch), "--host", "127.0.0.1",
                                        "--port", str(port), "--no-open"], cwd=root, env=env,
                                       stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
        for _ in range(180):
            if _identity(url, expected):
                (root / "host.pid").write_text(str(process.pid))
                return url
            if process.poll() is not None:
                break
            time.sleep(.25)
        if process.poll() is None:
            process.terminate()
        raise RuntimeError(f"共享 DSH 插件启动失败，详见 {log}")
    finally:
        lock.close()
