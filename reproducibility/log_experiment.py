#!/usr/bin/env python3
"""
实验日志记录器 (可复现性)
============================
记录每个实验的完整元数据: 时间戳、命令、参数、环境(工具版本)、
输入/输出文件哈希、运行时长、结果摘要。所有记录追加到
reproducibility/experiments.ndjson (每行一个 JSON 实验记录)。

用途: 确保任何实验都可被审稿人复现, 无参数/环境遗漏。
本文件为仓库自包含版本, 仅依赖 Python 标准库。
"""
import hashlib, json, os, platform, subprocess, sys, time, uuid, socket
from pathlib import Path

LOGDIR = Path(__file__).parent
LOG = LOGDIR / "experiments.ndjson"


def file_sha256(path: str) -> str:
    p = Path(path)
    if not p.exists():
        return "MISSING"
    h = hashlib.sha256()
    try:
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception as e:
        return f"ERR:{e}"


def dir_manifest(dirpath: str, prefix: str = ""):
    """列出目录下所有文件的 sha256 (用于数据目录指纹)"""
    base = Path(dirpath)
    if not base.is_dir():
        return {"_dir": str(base), "exists": False}
    out = {}
    for f in sorted(base.rglob("*")):
        if f.is_file():
            rel = str(f.relative_to(base))
            out[prefix + rel] = file_sha256(str(f))
    return out


def env_snapshot():
    """环境与工具版本"""
    vers = {}
    for cmd in [["python3", "--version"], ["node", "--version"]]:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            vers[" ".join(cmd[:1]) + " " + cmd[-1]] = r.stdout.strip() or r.stderr.strip()
        except Exception as e:
            vers[" ".join(cmd)] = f"ERR:{e}"
    return {
        "os": platform.platform(),
        "machine": platform.machine(),
        "cpu": os.cpu_count(),
        "hostname": socket.gethostname(),
        "python_impl": platform.python_implementation(),
        "tool_versions": vers,
    }


def record(exp_name, params=None, inputs=None, outputs=None, metrics=None, notes=None):
    rec = {
        "exp_id": uuid.uuid4().hex[:12],
        "experiment": exp_name,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S %z"),
        "unix_ts": time.time(),
        "cwd": str(Path.cwd()),
        "command": " ".join(sys.argv),
        "env": env_snapshot(),
        "params": params or {},
        "inputs": inputs or {},
        "outputs": outputs or {},
        "metrics": metrics or {},
        "notes": notes or "",
    }
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return rec["exp_id"]
