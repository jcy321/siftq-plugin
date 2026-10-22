# SiftQ MiniMax-H3 调用示范

本文件列出所有支持的调用方式与参数。所有请求都是标准 OpenAI Video 协议：

- 创建任务：`POST /v1/videos`
- 查询任务：`GET /v1/videos/{task_id}`
- 下载成品：`GET /v1/videos/{task_id}/content`

先设置两个变量，后面所有示例都复用：

```bash
# 你的 NewAPI 网关地址（换成实际域名，如 https://product.sxls.fun）
export BASE_URL="https://product.sxls.fun"

# 你的令牌（在 NewAPI 控制台创建，形如 sk-xxxx）
export API_KEY="sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

---

## 一、参数总表

### 顶层字段（放在请求体最外层）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | 字符串 | **是** | 固定填 `MiniMax-H3` |
| `prompt` | 字符串 | **是** | 提示词，最长 7000 字符。没有提示词会报错 |
| `resolution` | 字符串 | 否 | `480P` / `768P` / `1080P` / `2K`，默认 `768P` |
| `duration` | 整数 | 否 | 时长（秒），默认 5。范围见下表 |
| `ratio` | 字符串 | 否 | `adaptive` / `21:9` / `16:9`（默认） / `4:3` / `1:1` / `3:4` / `9:16` |
| `image_url` | 字符串 | 否 | 首帧图 URL（图生视频） |
| `images` | 字符串数组 | 否 | 首帧+尾帧图，最多 2 张（第 1 张=首帧，第 2 张=尾帧） |
| `fast_mode` | 布尔 | 否 | 快速模式，费用 **2 倍**。默认 false |
| `context_ir_enabled` | 布尔 | 否 | 上下文增强（IR），额外 **$0.01/次**。默认 false |
| `callback_url` | 字符串 | 否 | 任务状态回调地址，需返回 challenge 校验 |
| `aigc_watermark` | 布尔 | 否 | 是否加 AIGC 水印 |
| `metadata` | 对象 | 否 | 参考素材与上述部分参数的容器（见下） |

### `metadata` 内的字段

| 参数 | 类型 | 说明 |
|------|------|------|
| `reference_image` | 字符串或数组 | 参考图 URL，最多 9 张。**前 5 张免费**，第 6 张起 $0.0126/张 |
| `reference_video` | 字符串或数组 | 参考视频 URL，最多 3 个。按自身时长计费 |
| `reference_audio` | 字符串或数组 | 参考音频 URL，最多 3 个。免费 |
| `resolution` / `ratio` / `fast_mode` / `context_ir_enabled` / `callback_url` / `aigc_watermark` | 同上 | 也可以放进 metadata |

### 时长限制（按分辨率）

| 分辨率 | 允许时长 | 16–30 秒计费 |
|--------|---------|-------------|
| 480P | 4–30 秒 | 按 2 倍单价计（$0.0468/秒） |
| 768P | 4–30 秒 | 按 2 倍单价计（$0.0571/秒） |
| 1080P | 4–15 秒 | 不支持更长 |
| 2K | 4–15 秒 | 不支持更长 |

### 三种生成模式（互斥，不能混用）

| 模式 | 怎么传 | action |
|------|--------|--------|
| 文生视频 | 只传 `prompt` | `textGenerate` |
| 图生视频（首帧） | `prompt` + `image_url` | `generate` |
| 图生视频（首尾帧） | `prompt` + `images: [首帧, 尾帧]` | `firstTailGenerate` |
| 参考生视频 | `prompt` + `metadata.reference_*` | `referenceGenerate` |

> **重要**：帧图（`image_url` / `images`）与参考素材（`metadata.reference_*`）**不能同时使用**，同时传会被拒绝。

### 计费公式

```
总费用 = context_ir附加费($0.01/次)
       + fast_mode(2倍)
       × ( 输出秒数 × 分辨率单价
         + 参考视频秒数 × 分辨率单价
         + max(0, 参考图张数 - 5) × 图片单价 )
```

单价（美元/秒）：

| 分辨率 | 4–15s 输出 | 4–15s 参考视频 | 16–30s 输出 | 16–30s 参考视频 |
|--------|-----------|---------------|------------|----------------|
| 480P | 0.02 | 0.0184 | 0.0468 | 0.0368 |
| 768P | 0.03 | 0.0236 | 0.0571 | 0.0471 |
| 1080P | 0.04 | 0.0368 | — | — |
| 2K | 0.05 | 0.0393 | — | — |

图片：前 5 张免费，第 6 张起 0.0126/张（16–30 秒档为 0.0252/张）

---

## 二、文生视频（最简单）

```bash
curl -s -X POST "$BASE_URL/v1/videos" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "MiniMax-H3",
    "prompt": "黄昏时分，樱花缓缓落在锦鲤池上，电影感，金色光线",
    "resolution": "480P",
    "duration": 4,
    "ratio": "16:9"
  }'
```

返回：

```json
{
  "id": "task_xxxxxxxxxxxxxxxx",
  "object": "video",
  "model": "MiniMax-H3",
  "status": "queued",
  "progress": 0,
  "created_at": 1792596798
}
```

记下 `id`，用于查询和下载。

---

## 三、图生视频（单张首帧图）

```bash
curl -s -X POST "$BASE_URL/v1/videos" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "MiniMax-H3",
    "prompt": "镜头缓慢推进，人物微微转头",
    "image_url": "https://example.com/first-frame.png",
    "resolution": "768P",
    "duration": 5,
    "ratio": "adaptive"
  }'
```

> `ratio` 传 `adaptive` 表示按输入图片的宽高比自动决定。
> 只传一张图时，不传 `ratio` 也可以（默认 `16:9`，但上游会按图自动调整）。

---

## 四、图生视频（首帧 + 尾帧）

```bash
curl -s -X POST "$BASE_URL/v1/videos" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "MiniMax-H3",
    "prompt": "春到冬的四季过渡，镜头保持固定",
    "images": [
      "https://example.com/spring.png",
      "https://example.com/winter.png"
    ],
    "resolution": "768P",
    "duration": 6,
    "ratio": "adaptive"
  }'
```

> `images` 数组第 1 张是**首帧**，第 2 张是**尾帧**。最多 2 张。

---

## 五、参考生视频（参考图 + 参考视频 + 参考音频）

```bash
curl -s -X POST "$BASE_URL/v1/videos" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "MiniMax-H3",
    "prompt": "角色说出：随风而行，自由生活。音色参考参考音频 1",
    "resolution": "768P",
    "duration": 8,
    "ratio": "adaptive",
    "metadata": {
      "reference_image": [
        "https://example.com/character-1.png",
        "https://example.com/character-2.png"
      ],
      "reference_video": ["https://example.com/motion.mp4"],
      "reference_audio": ["https://example.com/voice.mp3"]
    }
  }'
```

> 三类参考素材可以任意组合，只要都在 `metadata` 里、且不使用帧图即可。
> **计费提醒**：参考视频按自身时长计费；参考图前 5 张免费，第 6 张起收费。

---

## 六、快速模式（fast_mode，费用 2 倍）

```bash
curl -s -X POST "$BASE_URL/v1/videos" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "MiniMax-H3",
    "prompt": "一只猫在月球上散步",
    "resolution": "480P",
    "duration": 8,
    "fast_mode": true
  }'
```

> `fast_mode: true` 时费用翻倍。
> 例：480P 8 秒 = 0.02 × 8 = $0.16 → 快速模式 $0.32。
>
> `fast_mode` 也可以写在 `metadata` 里，两种写法等价。

---

## 七、上下文增强（context_ir_enabled，+$0.01/次）

```bash
curl -s -X POST "$BASE_URL/v1/videos" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "MiniMax-H3",
    "prompt": "角色说话，语气温柔",
    "resolution": "768P",
    "duration": 8,
    "metadata": {
      "reference_image": ["https://example.com/char.png"],
      "reference_audio": ["https://example.com/voice.mp3"],
      "context_ir_enabled": true
    }
  }'
```

> 上下文增强能提升模型对参考素材的理解。额外收费 $0.01/次，**不受 fast_mode 的 2 倍影响**。
> 适合参考图/参考音频较多的复杂场景。

---

## 八、16–30 秒长视频（仅 480P / 768P）

```bash
curl -s -X POST "$BASE_URL/v1/videos" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "MiniMax-H3",
    "prompt": "一段完整的日落延时摄影",
    "resolution": "768P",
    "duration": 20,
    "ratio": "16:9"
  }'
```

> 只有 480P / 768P 支持 16–30 秒，单价翻倍（768P 20 秒 = 0.0571 × 20 = $1.142）。
> 1080P / 2K 传超过 15 秒会被拒绝。

---

## 九、全部参数都用上（组合示例）

```bash
curl -s -X POST "$BASE_URL/v1/videos" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "MiniMax-H3",
    "prompt": "参考音频1的音色，角色面向镜头说：欢迎回来",
    "resolution": "768P",
    "duration": 10,
    "ratio": "adaptive",
    "fast_mode": false,
    "context_ir_enabled": true,
    "aigc_watermark": true,
    "callback_url": "https://your-app.example.com/webhooks/siftq",
    "metadata": {
      "reference_image": [
        "https://example.com/ref-1.png",
        "https://example.com/ref-2.png",
        "https://example.com/ref-3.png",
        "https://example.com/ref-4.png",
        "https://example.com/ref-5.png",
        "https://example.com/ref-6.png"
      ],
      "reference_video": ["https://example.com/ref-motion.mp4"],
      "reference_audio": ["https://example.com/ref-voice.mp3"]
    }
  }'
```

上面这个例子的计费拆解（768P，10 秒）：

```
参考图 6 张 → 前 5 张免费，第 6 张收 0.0126
参考视频按自身时长计（假设 5 秒）→ 5 × 0.0236 = 0.118
输出 10 秒 → 10 × 0.03 = 0.30
小计 = 0.30 + 0.118 + 0.0126 = 0.4306
fast_mode = false → 不翻倍
context_ir = true → +0.01
总计 = $0.4406 ≈ quota 220300
```

> `callback_url` 配了以后，上游会先发一次 challenge 校验请求（3 秒内原样返回 challenge），
> 验证通过后每次任务状态变化都会 POST 到该地址。轮询仍然可用，二者不冲突。

---

## 十、查询任务状态

```bash
curl -s "$BASE_URL/v1/videos/{task_id}" \
  -H "Authorization: Bearer $API_KEY"
```

返回（生成中）：

```json
{
  "id": "task_xxxxxxxxxxxxxxxx",
  "object": "video",
  "model": "MiniMax-H3",
  "status": "in_progress",
  "progress": 50,
  "created_at": 1792596798
}
```

返回（已完成）：

```json
{
  "id": "task_xxxxxxxxxxxxxxxx",
  "object": "video",
  "model": "MiniMax-H3",
  "status": "completed",
  "progress": 100,
  "seconds": 4,
  "created_at": 1792596798,
  "completed_at": 1792596837
}
```

`status` 取值：`queued`（排队）、`in_progress`（生成中）、`completed`（成功）、`failed`（失败）。

### 轮询脚本

```bash
TASK_ID="task_xxxxxxxxxxxxxxxx"

for i in $(seq 1 30); do
  RESP=$(curl -s "$BASE_URL/v1/videos/$TASK_ID" -H "Authorization: Bearer $API_KEY")
  STATUS=$(echo "$RESP" | jq -r '.status')
  echo "[$i] status=$STATUS"
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    echo "$RESP" | jq .
    break
  fi
  sleep 10
done
```

---

## 十一、下载成品视频

```bash
curl -L -o output.mp4 \
  "$BASE_URL/v1/videos/{task_id}/content" \
  -H "Authorization: Bearer $API_KEY"
```

> **注意**：网关会返回 302 跳转到上游 CDN，`curl` 必须加 `-L` 才会跟随跳转。
> 浏览器里 `<video>` 和 `<a download>` 会自动跟随，不需要额外处理。
> 文件名由上游 CDN 的 `Content-Disposition` 决定（形如 `video-2112868601797619712.mp4`）。

---

## 十二、错误对照表

| 返回 | 原因 | 解决 |
|------|------|------|
| `model is required` | 没传 `model` | 填 `MiniMax-H3` |
| `MiniMax-H3 requires a prompt or a media input` | 没传 `prompt` 也没传图 | 补 `prompt` |
| `duration must be between 4 and 15 seconds for 2K` | 2K 超过 15 秒 | 改短或换 480P/768P |
| `image-to-video (frame) and reference-to-video are mutually exclusive` | 帧图和参考素材混用 | 二选一 |
| `accepts at most 2 frame images` | `images` 超过 2 张 | 最多首帧+尾帧 |
| `accepts at most 9 reference images` | `reference_image` 超过 9 张 | 减到 9 张以内 |
| `ratio adaptive requires an image or video input` | 纯文本却传了 `adaptive` | 换成具体比例，如 `16:9` |
| `plugin_usage_invalid` | 参数类型不对（如 fast_mode 传字符串） | 用布尔值 `true` / `false` |
| `insufficient_user_quota` | 用户额度不足 | 充值或换令牌 |
| `model_price_error` | 计费表达式未配置 | 联系管理员配置 `billing_expr` |

---

## 十三、Python 调用示例

```python
import time
import requests

BASE_URL = "https://product.sxls.fun"
API_KEY = "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
HEADERS = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}

# 1. 创建任务
resp = requests.post(f"{BASE_URL}/v1/videos", headers=HEADERS, json={
    "model": "MiniMax-H3",
    "prompt": "黄昏时分，樱花落在锦鲤池上，电影感",
    "resolution": "480P",
    "duration": 4,
    "ratio": "16:9",
})
resp.raise_for_status()
task_id = resp.json()["id"]
print("task_id:", task_id)

# 2. 轮询
while True:
    r = requests.get(f"{BASE_URL}/v1/videos/{task_id}", headers=HEADERS)
    data = r.json()
    print("status:", data["status"], "progress:", data.get("progress"))
    if data["status"] in ("completed", "failed"):
        break
    time.sleep(10)

# 3. 下载（requests 自动跟随 302）
if data["status"] == "completed":
    with requests.get(f"{BASE_URL}/v1/videos/{task_id}/content", headers=HEADERS, stream=True) as r:
        r.raise_for_status()
        with open("output.mp4", "wb") as f:
            for chunk in r.iter_content(65536):
                f.write(chunk)
    print("saved output.mp4")
```
