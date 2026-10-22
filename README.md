# SiftQ MiniMax-H3 Task Plugin

## 用途
替代内置 hailuo@1.2.1 插件对 SiftQ 供应商的兼容缺陷，完整支持：
- 480P / 768P / 1080P / 2K 四档分辨率
- image_url / images / reference_video / reference_audio 多模态输入
- fast_mode / context_ir_enabled 透传并写回 usage_facts
- extractUsage / extractUsageOnComplete 完整 billing 事实提取

## 部署方法（任一 NewAPI 容器）

### 方式 A：直接写数据库
```bash
# 计算 hash
HASH=$(sha256sum plugin.js | awk '{print $1}')

# 插入 task_plugins 表（PostgreSQL，替换 DSN）
docker exec data-plane_postgres_1 psql "$DSN" -c "
INSERT INTO task_plugins (key, api_version, version, source, source_hash, icon, enabled, active, created_at, remark)
VALUES ('siftq', 1, '1.0.0', \$\$<把 plugin.js 内容读进来>\$\$, '$HASH', '', true, true, $(date +%s), 'SiftQ H3 custom plugin');
"
```

实际操作建议用 Python 脚本写入（source 是长文本，避免 shell 转义问题）：

```python
import subprocess, hashlib

with open("plugin.js", "r") as f:
    source = f.read()
hash = hashlib.sha256(source.encode()).hexdigest()
# 然后 subprocess 调 psql 写入
```

### 方式 B：管理后台 UI
管理后台 → 任务插件 → 从源码安装 → 粘贴 plugin.js 内容

### 绑定渠道
在 NewAPI 渠道编辑界面：
- 渠道类型选 58（高级自定义）
- task_plugin_key 填 `siftq`
- Base URL 填 `<供应商 API 根地址>`（如 `https://<vendor-host>/api/<path>`）

## 验证步骤
1. 重启 NewAPI 容器（数据库直插需重启才能刷新缓存）
2. `curl https://<站点>/api/plugin/task` 应列出 siftq
3. 调用 `/v1/video/generations` 传 `resolution: "480P"` 确认返回非 768P

## 更新日志
- 2026-10-20 v1.0.0 初版：修复分辨率/多模态/fast_mode 三大缺陷
