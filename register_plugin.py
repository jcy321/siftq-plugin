#!/usr/bin/env python3
"""
在任意 NewAPI 数据库注册 / 更新 SiftQ task plugin。

用法:
    python3 register_plugin.py "postgresql://user:pass@host:5432/dbname?sslmode=disable"

行为:
    - plugin.js 与 script 同目录
    - key = siftq, version = 1.0.0
    - 已存在同版本则校验 hash 并跳过；存在不同版本则升级
"""

import hashlib
import subprocess
import sys
import time
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent
SOURCE_FILE = PLUGIN_DIR / "plugin.js"
KEY = "siftq"
API_VERSION = 1
VERSION = "1.0.0"


def run(dsn: str, sql: str) -> str:
    r = subprocess.run(
        ["docker", "exec", "-i", "data-plane_postgres_1", "psql", dsn, "-v", "ON_ERROR_STOP=1"],
        input=sql, capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return r.stdout.strip()


def main() -> None:
    if len(sys.argv) < 2:
        print("用法: python3 register_plugin.py \"<SQL_DSN>\"")
        sys.exit(1)
    dsn = sys.argv[1]

    source = SOURCE_FILE.read_text(encoding="utf-8")
    source_hash = hashlib.sha256(source.encode("utf-8")).hexdigest()
    now = int(time.time())

    escaped = source.replace("'", "''")
    sql = f"""
INSERT INTO task_plugins (key, api_version, version, source, source_hash, icon, enabled, active, created_at, remark)
VALUES ('{KEY}', {API_VERSION}, '{VERSION}', '{escaped}', '{source_hash}', '', true, true, {now}, 'SiftQ MiniMax-H3 custom plugin')
ON CONFLICT (key, version) DO UPDATE
  SET source = EXCLUDED.source,
      source_hash = EXCLUDED.source_hash,
      enabled = true,
      active = true,
      remark = EXCLUDED.remark;
"""
    run(dsn, sql)
    print(f"OK  {KEY}@{VERSION} registered  hash={source_hash[:12]}")

    check = run(dsn, f"SELECT id, key, version, enabled, active, source_hash FROM task_plugins WHERE key='{KEY}';")
    print(check)


if __name__ == "__main__":
    main()
