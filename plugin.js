// SiftQ MiniMax-H3 定制插件
// 修复内置 hailuo 插件的三个缺陷：
//   1. resolution 只支持 768P/2K -> 完整支持 480P/768P/1080P/2K
//   2. image_url / images / video_url / audio_url 输入被丢弃 -> 完整封装进 content[]
//   3. fast_mode / context_ir_enabled 被丢弃 -> 透传并把事实写回 usage_facts
// 基于 NewAPI task plugin api v1 协议（参考内置 hailuo@1.2.1 hook 签名与 ctx 结构）

const MODEL = "MiniMax-H3";
const DEFAULT_DURATION = 5;
const MIN_DURATION = 4;
const MAX_DURATION = 15;

const RESOLUTIONS = ["480P", "768P", "1080P", "2K"];
const RATIOS = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

const MAX_FRAME_IMAGES = 2;
const MAX_REFERENCE_IMAGES = 9;
const MAX_REFERENCE_VIDEOS = 3;
const MAX_REFERENCE_AUDIOS = 3;
const MAX_INPUT_VIDEO_SECONDS = 15;

const DURATION_LIMITS = { "480P": [4, 30], "768P": [4, 30], "1080P": [4, 15], "2K": [4, 15] };

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(function (item) { return typeof item === "string"; });
}

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

function normalizeResolution(raw) {
  const value = trimmed(raw).toUpperCase();
  if (!value) return "768P";
  if (value.includes("2K")) return "2K";
  if (value.includes("1080")) return "1080P";
  if (value.includes("768")) return "768P";
  if (value.includes("480")) return "480P";
  throw new Error(MODEL + " resolution must be one of " + RESOLUTIONS.join(", "));
}

function normalizeDuration(raw, resolution) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_DURATION;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds)) {
    throw new Error(MODEL + " duration must be an integer");
  }
  const limits = DURATION_LIMITS[resolution] || [MIN_DURATION, MAX_DURATION];
  if (seconds < limits[0] || seconds > limits[1]) {
    throw new Error(MODEL + " duration must be between " + limits[0] + " and " + limits[1] + " seconds for " + resolution);
  }
  return seconds;
}

function normalizeRatio(raw, hasVisual) {
  const value = trimmed(raw).toLowerCase();
  if (!value) return "16:9";
  if (!RATIOS.includes(value)) {
    throw new Error(MODEL + " ratio must be one of " + RATIOS.join(", "));
  }
  if (value === "adaptive" && !hasVisual) {
    throw new Error(MODEL + " ratio adaptive requires an image or video input");
  }
  return value;
}

function normalizeBoolean(raw) {
  if (raw === undefined || raw === null || raw === "") return false;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const v = raw.toLowerCase();
    if (v === "true" || v === "1" || v === "yes") return true;
    if (v === "false" || v === "0" || v === "no") return false;
  }
  if (typeof raw === "number") return raw !== 0;
  throw new Error(MODEL + " fast_mode / context_ir_enabled must be a boolean");
}

function mediaItem(type, url, role) {
  const item = { type: type, role: role };
  item[type] = { url: url };
  return item;
}

// Accepts string | string[] | {url} | {url}[]
function mediaList(source, key) {
  const raw = source[key];
  if (raw === undefined || raw === null) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const value of values) {
    if (typeof value === "string") {
      if (trimmed(value)) out.push(trimmed(value));
      continue;
    }
    if (value && typeof value === "object") {
      const url = trimmed(value.url);
      if (url) out.push(url);
    }
  }
  return out;
}

function collectFrames(requestBody) {
  const images = mediaList(requestBody, "image_url");
  const multi = mediaList(requestBody, "images");
  const all = images.concat(multi);
  if (all.length > MAX_FRAME_IMAGES) {
    throw new Error(MODEL + " accepts at most " + MAX_FRAME_IMAGES + " frame images (first_frame + last_frame)");
  }
  return all;
}

function buildContent(requestBody) {
  const metadata = requestBody.metadata || {};
  const content = [];
  const prompt = trimmed(requestBody.prompt);
  if (prompt) content.push({ type: "text", text: prompt });

  const frames = collectFrames(requestBody);
  for (let i = 0; i < frames.length; i++) {
    content.push(mediaItem("image_url", frames[i], i === 0 ? "first_frame" : "last_frame"));
  }

  const refImages = mediaList(metadata, "reference_image");
  if (refImages.length > MAX_REFERENCE_IMAGES) {
    throw new Error(MODEL + " accepts at most " + MAX_REFERENCE_IMAGES + " reference images");
  }
  for (const url of refImages) content.push(mediaItem("image_url", url, "reference_image"));

  const videos = mediaList(metadata, "reference_video");
  if (videos.length > MAX_REFERENCE_VIDEOS) {
    throw new Error(MODEL + " accepts at most " + MAX_REFERENCE_VIDEOS + " reference videos");
  }
  for (const url of videos) content.push(mediaItem("video_url", url, "reference_video"));

  const audios = mediaList(metadata, "reference_audio");
  if (audios.length > MAX_REFERENCE_AUDIOS) {
    throw new Error(MODEL + " accepts at most " + MAX_REFERENCE_AUDIOS + " reference audios");
  }
  for (const url of audios) content.push(mediaItem("audio_url", url, "reference_audio"));

  const hasFrame = frames.length > 0;
  const hasRef = refImages.length > 0 || videos.length > 0 || audios.length > 0;
  if (hasFrame && hasRef) {
    throw new Error(MODEL + " image-to-video (frame) and reference-to-video are mutually exclusive");
  }

  if (!content.length) {
    throw new Error(MODEL + " requires a prompt or a media input");
  }
  if (!content.some(function (item) { return item && item.type === "text"; })) {
    throw new Error(MODEL + " requires a non-empty text item");
  }
  return content;
}

// Task-plugin channels do not auto-complete endpoint paths, so baseUrl may be
// either the API root or the full create endpoint. Normalize to the API root.
function apiRoot(ctx) {
  let base = trimmed(ctx.baseUrl).replace(/\/+$/, "");
  base = base.replace(/\/v2\/video_generation$/, "");
  return base;
}

function hasVisualContent(content) {
  return content.some(function (item) {
    return item && (item.type === "image_url" || item.type === "video_url");
  });
}

function responsesText(req) {
  const input = req.input;
  if (typeof input === "string") return trimmed(input);
  if (Array.isArray(input)) {
    const parts = [];
    for (const item of input) {
      if (typeof item === "string") { parts.push(item); continue; }
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const content = item.content === undefined ? [item] : (Array.isArray(item.content) ? item.content : [item.content]);
      for (const part of content) {
        if (typeof part === "string") { parts.push(part); continue; }
        if (part && typeof part === "object" && (part.type === "input_text" || part.type === "text") && typeof part.text === "string") {
          parts.push(part.text);
        }
      }
    }
    return parts.filter(function (t) { return trimmed(t); }).join("\n");
  }
  return trimmed(req.prompt);
}

function countImages(content) {
  return content.filter(function (item) { return item && item.type === "image_url"; }).length;
}

function hasVideoInput(content) {
  return content.some(function (item) { return item && item.type === "video_url"; });
}

function fastModeValue(requestBody) {
  const metadata = requestBody.metadata || {};
  const raw = metadata.fast_mode !== undefined ? metadata.fast_mode : requestBody.fast_mode;
  return normalizeBoolean(raw);
}

function contextIRValue(requestBody) {
  const metadata = requestBody.metadata || {};
  const raw = metadata.context_ir_enabled !== undefined
    ? metadata.context_ir_enabled
    : requestBody.context_ir_enabled;
  if (raw === undefined || raw === null || raw === "") return undefined;
  return normalizeBoolean(raw);
}

// 前端 TASK_ACTION_MAPPINGS 使用旧版驼峰命名作为键，
// 规范命名（text_to_video 等）无法匹配 → 显示"未知"。
// 返回旧版命名以兼容原版 NewAPI 前端，i18n 自动映射为中文。
function legacyAction(content) {
  var frames = 0, hasRef = false;
  for (var i = 0; i < content.length; i++) {
    var item = content[i];
    if (!item || typeof item !== "object") continue;
    if (item.role === "first_frame" || item.role === "last_frame") frames++;
    if (item.role && String(item.role).indexOf("reference_") === 0) hasRef = true;
  }
  if (hasRef) return "referenceGenerate";
  if (frames >= 2) return "firstTailGenerate";
  if (frames === 1) return "generate";
  return "textGenerate";
}

export function buildSubmitRequest(ctx) {
  const requestBody = ctx.requestBody || {};
  const content = buildContent(requestBody);
  const resolution = normalizeResolution(
    (requestBody.metadata || {}).resolution || requestBody.resolution || requestBody.size
  );
  const duration = normalizeDuration(requestBody.duration !== undefined ? requestBody.duration : requestBody.seconds, resolution);
  const ratio = normalizeRatio(requestBody.ratio, hasVisualContent(content));

  const body = {
    model: ctx.upstreamModel || MODEL,
    content: content,
    resolution: resolution,
    duration: duration,
    ratio: ratio,
  };

  const fastMode = fastModeValue(requestBody);
  if (fastMode) body.fast_mode = true;

  const contextIR = contextIRValue(requestBody);
  if (contextIR !== undefined) body.context_ir_enabled = contextIR;

  const metadata = requestBody.metadata || {};
  ["callback_url", "aigc_watermark"].forEach(function (key) {
    if (metadata[key] !== undefined && metadata[key] !== null) body[key] = metadata[key];
  });

  return {
    url: apiRoot(ctx) + "/v2/video_generation",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "Bearer " + ctx.apiKey,
    },
    body: body,
    action: legacyAction(content),
  };
}

export function parseSubmitResponse(ctx, resp) {
  const body = (resp && resp.body) || {};
  const error = body.error;
  if (error && typeof error === "object" && trimmed(error.message)) {
    throw new Error(trimmed(error.message));
  }
  const base = body.base_resp;
  if (base && base.status_code !== 0) {
    throw new Error(trimmed(base.status_msg) || (MODEL + " submit failed"));
  }
  const taskId = trimmed(body.task_id || body.id);
  if (!taskId) throw new Error("missing task_id");
  return { taskId: taskId, taskData: body };
}

export function extractUsage(ctx) {
  if (ctx.usagePurpose === "billing_ratios") return null;
  const requestBody = ctx.requestBody || {};
  const content = buildContent(requestBody);
  const resolution = normalizeResolution(
    (requestBody.metadata || {}).resolution || requestBody.resolution || requestBody.size
  );
  return {
    seconds: normalizeDuration(requestBody.duration !== undefined ? requestBody.duration : requestBody.seconds, resolution),
    resolution: resolution,
    input_images: countImages(content),
    // 输入 URL 不暴露时长；先按文档上限预留，任务完成后由 usage.input_seconds 覆写
    input_video_seconds: hasVideoInput(content) ? MAX_INPUT_VIDEO_SECONDS : 0,
    fast_mode: fastModeValue(requestBody),
    context_ir_enabled: contextIRValue(requestBody) === true,
  };
}

export function buildQueryRequest(ctx) {
  return {
    url: apiRoot(ctx) + "/v2/query/video_generation/" + encodeURIComponent(ctx.taskId),
    method: "GET",
    headers: { Accept: "application/json", Authorization: "Bearer " + ctx.apiKey },
  };
}

function apiError(body) {
  const error = body && typeof body === "object" ? body.error : null;
  if (!error || typeof error !== "object") return null;
  const message = trimmed(error.message);
  if (!message) return null;
  const code = Number(error.http_code || error.code || 0);
  return { message: message, code: Number.isInteger(code) ? code : 0 };
}

export function parseTaskResult(ctx, body) {
  const error = apiError(body);
  if (error) {
    if (error.code === 408 || error.code === 429 || error.code >= 500) {
      throw new Error(error.message);
    }
    return { code: error.code, status: "FAILURE", progress: "100%", reason: error.message };
  }

  const task = body && typeof body === "object" && !Array.isArray(body) ? body.task : null;
  if (task && typeof task === "object" && !Array.isArray(task)) {
    const map = { queued: "QUEUED", running: "IN_PROGRESS", succeeded: "SUCCESS", failed: "FAILURE", cancelled: "FAILURE" };
    const status = map[task.status];
    if (!status) {
      return { status: "UNKNOWN", reason: "unrecognized status: " + String(task.status || "") };
    }
    const result = {
      code: 0,
      status: status,
      progress: status === "QUEUED" ? "30%" : status === "IN_PROGRESS" ? "50%" : "100%",
    };
    if (status === "SUCCESS") {
      const url = trimmed(task.content && task.content.url);
      if (url) result.url = url;
    }
    if (status === "FAILURE") {
      result.reason = trimmed(task.error && task.error.message) || "task failed";
    }
    return result;
  }

  const fallback = body && typeof body === "object" ? body.base_resp : null;
  if (fallback && fallback.status_code !== 0) {
    return { status: "FAILURE", progress: "100%", reason: trimmed(fallback.status_msg) || "task failed" };
  }
  return { status: "UNKNOWN", reason: "no task in response" };
}

function completeFacts(body) {
  const task = body && typeof body === "object" && !Array.isArray(body) ? body.task : null;
  if (!task || typeof task !== "object") return null;
  if (task.status !== "succeeded") return {};

  const facts = {};
  const resolution = trimmed(task.resolution).toUpperCase();
  if (RESOLUTIONS.includes(resolution)) facts.resolution = resolution;

  const usage = task.usage && typeof task.usage === "object" && !Array.isArray(task.usage) ? task.usage : {};
  // 仅提取上游会在查询响应中返回/修正的事实。
  // fast_mode / context_ir_enabled 是 create-only 参数，查询响应不回传，
  // 由提交期事实（extractUsage）经 overlay 保留，避免被完成期误覆写为 0。
  const fields = [
    { key: "seconds", value: usage.output_seconds, min: 0, max: 3600, integer: false },
    { key: "input_images", value: usage.input_image_count, min: 0, max: MAX_REFERENCE_IMAGES, integer: true },
    { key: "input_video_seconds", value: usage.input_seconds, min: 0, max: 3600, integer: false },
  ];
  for (const field of fields) {
    if (field.value === undefined || field.value === null || field.value === "") continue;
    let value = field.value;
    if (typeof value === "boolean") value = value ? 1 : 0;
    value = Number(value);
    if (!Number.isFinite(value) || value < field.min || value > field.max) continue;
    if (field.integer && !Number.isInteger(value)) continue;
    facts[field.key] = value;
  }
  return Object.keys(facts).length ? facts : null;
}

export function extractUsageOnComplete(task, taskResult, body) {
  return completeFacts(body);
}

export function listArtifacts(task) {
  if (task && task.status !== "SUCCESS") return [];
  return artifactVideoURL(task) ? [{ key: "video", type: "video", mimeType: "video/mp4" }] : [];
}

// SiftQ/MiniMax H3 任务成功后返回公网 CDN URL（task.content.url），
// 不存在需要鉴权的下载端点。credentialless 请求禁止携带 headers/body。
function artifactVideoURL(ctx) {
  const data = (ctx && ctx.data) || {};
  const task = data && typeof data === "object" && !Array.isArray(data) ? data.task : null;
  return task && typeof task === "object" && !Array.isArray(task)
    ? trimmed(task.content && task.content.url)
    : "";
}

export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("artifact_not_found");
  const url = artifactVideoURL(ctx);
  if (!url) throw new Error("artifact_not_found");
  return {
    url: url,
    method: ctx.clientRequest && ctx.clientRequest.method ? ctx.clientRequest.method : "GET",
    credentialless: true,
  };
}

// ---------------------------------------------------------------------------
// protocols
// ---------------------------------------------------------------------------

export const protocols = {
  openai_responses: {
    decodeRequest: function (ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
      const req = ctx.body.value;
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("request body must be an object");
      const model = trimmed(req.model || ctx.model);
      if (!model) throw new Error("model is required");
      if (req.input !== undefined && typeof req.input !== "string" && !Array.isArray(req.input)) {
        throw new Error("input must be a string or array");
      }
      if (req.images !== undefined && !Array.isArray(req.images)) throw new Error("images must be an array");
      if (req.metadata !== undefined && (!req.metadata || typeof req.metadata !== "object" || Array.isArray(req.metadata))) {
        throw new Error("metadata must be an object");
      }
      const prompt = responsesText(req);
      if (!prompt) throw new Error("input is required");
      const metadata = Object.assign({}, req.metadata || {});
      ["resolution", "ratio", "fast_mode", "context_ir_enabled", "duration", "seconds", "callback_url", "aigc_watermark"].forEach(function (key) {
        if (req[key] !== undefined && metadata[key] === undefined) metadata[key] = req[key];
      });
      return {
        kind: "submit",
        model: ctx.model,
        action: "text_to_video",
        requestBody: { model: model, prompt: prompt, metadata: metadata },
      };
    },
    renderFinal: function (ctx, _task) {
      const artifact = ctx && ctx.artifacts && ctx.artifacts.video;
      const url = trimmed(artifact && artifact.url);
      if (!url) throw new Error("video artifact is unavailable");
      const escaped = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return {
        output: [
          {
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: '<video controls src="' + escaped + '"></video>', annotations: [], logprobs: [] }],
          },
        ],
        metadata: { vendor: "siftq" },
      };
    },
  },
  openai_video: {
    decodeRequest: function (ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
      const req = ctx.body.value;
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("request body must be an object");
      const model = trimmed(req.model);
      if (!model) throw new Error("model is required");
      const metadata = req.metadata !== undefined && req.metadata !== null ? req.metadata : {};
      if (typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("metadata must be an object");

      function detectAction(r, md) {
        const hasFrame = r.image_url || (Array.isArray(r.images) && r.images.length);
        const hasRef = md.reference_image || md.reference_video || md.reference_audio;
        const frameCount = Array.isArray(r.images) ? r.images.length : (r.image_url ? 1 : 0);
        if (hasRef) return "referenceGenerate";
        if (frameCount >= 2) return "firstTailGenerate";
        if (hasFrame) return "generate";
        return "textGenerate";
      }

      if (req.metadata === undefined || req.metadata === null) {
        const passthrough = {};
        ["resolution", "ratio", "fast_mode", "context_ir_enabled", "callback_url", "aigc_watermark"].forEach(function (key) {
          if (req[key] !== undefined) passthrough[key] = req[key];
        });
        Object.keys(passthrough).forEach(function (key) { delete req[key]; });
        return {
          kind: "submit",
          model: ctx.model,
          action: detectAction(req, passthrough),
          requestBody: Object.assign({}, req, { model: ctx.model, metadata: Object.assign({}, passthrough) }),
        };
      }
      return {
        kind: "submit",
        model: ctx.model,
        action: detectAction(req, metadata),
        requestBody: Object.assign({}, req, { model: ctx.model }),
      };
    },
    render: function (ctx, task) {
      const statusMap = {
        QUEUED: "queued",
        IN_PROGRESS: "in_progress",
        SUCCESS: "completed",
        FAILURE: "failed",
      };
      const taskData = (task.data && task.data.task) || {};
      const output = {
        id: task.task_id,
        object: "video",
        model: "",
        status: statusMap[task.status] || "unknown",
        progress: Number(String(task.progress || "0").replace("%", "")),
        created_at: taskData.created_at || 0,
      };
      if (taskData.updated_at) output.completed_at = taskData.updated_at;
      if (taskData.duration) output.seconds = taskData.duration;
      if (task.status === "FAILURE") output.error = { message: task.fail_reason || "task failed", code: "" };
      return output;
    },
  },
};

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

export const meta = {
  key: "siftq",
  name: "SiftQ MiniMax-H3",
  version: "1.0.0",
  apiVersion: 1,
  author: { name: "sxls.fun ops" },
  website: "https://siftq.com/docs",
  description: "SiftQ MiniMax-H3 full-capability task plugin: all four resolutions, multimodal inputs, fast_mode and context IR facts.",
  baseUrl: "https://siftq.com/api/minimax",
  models: [MODEL],
  sortPriority: 100,
  fetchMode: "per_task",
  usageSchema: {
    seconds: { type: "number", unit: "second" },
    resolution: { enum: RESOLUTIONS },
    input_images: { type: "number", unit: "count" },
    input_video_seconds: { type: "number", unit: "second" },
    fast_mode: { type: "boolean" },
    context_ir_enabled: { type: "boolean" },
  },
  usageProfiles: [
    {
      models: [MODEL],
      schema: {
        seconds: { type: "number", unit: "second" },
        resolution: { enum: RESOLUTIONS },
        input_images: { type: "number", unit: "count" },
        input_video_seconds: { type: "number", unit: "second" },
        fast_mode: { type: "boolean" },
        context_ir_enabled: { type: "boolean" },
      },
      examples: [
        { label: "H3 768P 5s", facts: { seconds: 5, resolution: "768P", input_images: 0, input_video_seconds: 0, fast_mode: false, context_ir_enabled: false } },
        { label: "H3 480P 10s i2v", facts: { seconds: 10, resolution: "480P", input_images: 1, input_video_seconds: 0, fast_mode: false, context_ir_enabled: false } },
        { label: "H3 2K 8s fast", facts: { seconds: 8, resolution: "2K", input_images: 0, input_video_seconds: 0, fast_mode: true, context_ir_enabled: false } },
      ],
    },
  ],
  protocols: [{ name: "openai_responses", supports: ["background"] }, "openai_video"],
};
