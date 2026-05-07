const http = require("node:http");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

function loadDotEnv(filePath) {
  if (!fsSync.existsSync(filePath)) return;

  const lines = fsSync.readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) return;

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    if (!key || process.env[key] !== undefined) return;

    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  });
}

loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const AMAP_KEY = process.env.AMAP_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, ".data");
const MAX_LIBRARY_ITEMS = 200;
const BODY_LIMIT_BYTES = 10 * 1024 * 1024;
const DEFAULT_LIBRARY_SPACE = "default";
const LINK_PREVIEW_BYTES = 320 * 1024;
const LINK_PREVIEW_TIMEOUT_MS = 8000;
const AI_IMAGE_LIMIT = 3;
const AI_IMAGE_MAX_LENGTH = 2_800_000;

const AI_EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "city", "summary", "attractions", "foods", "notes", "confidence", "missingReason"],
  properties: {
    title: { type: "string" },
    city: { type: "string" },
    summary: { type: "string" },
    attractions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "addressHint", "reason", "confidence"],
        properties: {
          name: { type: "string" },
          addressHint: { type: "string" },
          reason: { type: "string" },
          confidence: { type: "number" },
        },
      },
    },
    foods: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "kind", "addressHint", "reason", "confidence"],
        properties: {
          name: { type: "string" },
          kind: { type: "string", enum: ["restaurant", "dish"] },
          addressHint: { type: "string" },
          reason: { type: "string" },
          confidence: { type: "number" },
        },
      },
    },
    notes: {
      type: "array",
      items: { type: "string" },
    },
    confidence: { type: "number" },
    missingReason: { type: "string" },
  },
};

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

function normalizeString(value, maxLength = 1000) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function uniqueStringArray(value, maxItems = 30, maxLength = 80) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const items = [];

  value.forEach((item) => {
    const normalized = normalizeString(item, maxLength);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    items.push(normalized);
  });

  return items.slice(0, maxItems);
}

function clampConfidence(value, fallback = 0.5) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function getLibrarySpace(req, url) {
  const rawSpace = req.headers["x-shunluchi-space"] || url.searchParams.get("space") || DEFAULT_LIBRARY_SPACE;
  const normalized = normalizeString(Array.isArray(rawSpace) ? rawSpace[0] : rawSpace, 48)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  return normalized || DEFAULT_LIBRARY_SPACE;
}

function getLibraryFile(space) {
  return path.join(DATA_DIR, `library-${space}.json`);
}

function normalizeDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function normalizeMedia(items) {
  if (!Array.isArray(items)) return [];
  return items
    .slice(0, 12)
    .map((item) => ({
      name: normalizeString(item?.name, 160),
      type: normalizeString(item?.type, 80),
      size: Number.isFinite(Number(item?.size)) ? Number(item.size) : 0,
      channel: normalizeString(item?.channel, 80),
    }))
    .filter((item) => item.name);
}

function normalizeEntities(items) {
  if (!Array.isArray(items)) return [];
  return items
    .slice(0, 80)
    .map((item) => ({
      id: normalizeString(item?.id, 180),
      name: normalizeString(item?.name, 120),
      city: normalizeString(item?.city, 80),
      kind: normalizeString(item?.kind, 40) || "dish",
      category: normalizeString(item?.category, 120),
      area: normalizeString(item?.area, 120),
      address: normalizeString(item?.address, 240),
      opening: normalizeString(item?.opening, 160),
      notes: uniqueStringArray(item?.notes, 8, 160),
      confidence: Number.isFinite(Number(item?.confidence)) ? Math.max(0, Math.min(1, Number(item.confidence))) : 0.5,
      source: normalizeString(item?.source, 120),
      lng: Number.isFinite(Number(item?.lng)) ? Number(item.lng) : undefined,
      lat: Number.isFinite(Number(item?.lat)) ? Number(item.lat) : undefined,
      x: Number.isFinite(Number(item?.x)) ? Number(item.x) : undefined,
      y: Number.isFinite(Number(item?.y)) ? Number(item.y) : undefined,
    }))
    .filter((item) => item.name);
}

function normalizeLibraryEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  const attractions = uniqueStringArray(entry.attractions, 30, 80);
  const foods = uniqueStringArray(entry.foods, 40, 80);
  if (!attractions.length && !foods.length) return null;

  const createdAt = normalizeDate(entry.createdAt);
  const fallbackId = `entry-${createdAt.replace(/[^0-9]/g, "")}`;

  return {
    id: normalizeString(entry.id, 160) || fallbackId,
    title: normalizeString(entry.title, 180) || "未命名攻略",
    source: normalizeString(entry.source, 6000),
    sourceUrl: normalizeString(entry.sourceUrl, 600),
    city: normalizeString(entry.city, 80) || "上海",
    createdAt,
    attractions,
    foods,
    notes: uniqueStringArray(entry.notes, 12, 180),
    media: normalizeMedia(entry.media),
    entities: normalizeEntities(entry.entities),
    linkInspection: entry.linkInspection && typeof entry.linkInspection === "object" ? entry.linkInspection : null,
    fingerprint: normalizeString(entry.fingerprint, 700),
  };
}

async function readRequestJson(req) {
  let body = "";

  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > BODY_LIMIT_BYTES) {
      throw new Error("payload_too_large");
    }
  }

  if (!body.trim()) return {};
  return JSON.parse(body);
}

async function readLibraryStore(space = DEFAULT_LIBRARY_SPACE) {
  const libraryFile = getLibraryFile(space);

  try {
    const raw = await fs.readFile(libraryFile, "utf8");
    const parsed = JSON.parse(raw);
    const library = Array.isArray(parsed.library) ? parsed.library.map(normalizeLibraryEntry).filter(Boolean) : [];
    return {
      version: 1,
      space,
      updatedAt: normalizeDate(parsed.updatedAt),
      library: library.slice(0, MAX_LIBRARY_ITEMS),
    };
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("资料库读取失败，已使用空资料库。", error.message);
    return {
      version: 1,
      space,
      updatedAt: new Date().toISOString(),
      library: [],
    };
  }
}

async function writeLibraryStore(library, space = DEFAULT_LIBRARY_SPACE) {
  const libraryFile = getLibraryFile(space);
  const store = {
    version: 1,
    space,
    updatedAt: new Date().toISOString(),
    library: library.map(normalizeLibraryEntry).filter(Boolean).slice(0, MAX_LIBRARY_ITEMS),
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${libraryFile}.${process.pid}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tempFile, libraryFile);
  return store;
}

async function replaceCloudLibrary(items, space) {
  const normalized = Array.isArray(items) ? items.map(normalizeLibraryEntry).filter(Boolean) : [];
  normalized.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return writeLibraryStore(normalized, space);
}

async function upsertCloudEntry(entry, space) {
  const normalized = normalizeLibraryEntry(entry);
  if (!normalized) return null;

  const store = await readLibraryStore(space);
  const key = normalized.fingerprint || normalized.id;
  const nextLibrary = [
    normalized,
    ...store.library.filter((item) => (item.fingerprint || item.id) !== key && item.id !== normalized.id),
  ];
  return writeLibraryStore(nextLibrary, space);
}

async function deleteCloudEntry(id, space) {
  const store = await readLibraryStore(space);
  const nextLibrary = store.library.filter((item) => item.id !== id);
  return writeLibraryStore(nextLibrary, space);
}

function getLanUrls() {
  const interfaces = os.networkInterfaces();
  const urls = [];

  Object.values(interfaces).forEach((items = []) => {
    items.forEach((item) => {
      if (item.family !== "IPv4" || item.internal) return;
      urls.push(`http://${item.address}:${PORT}/app`);
    });
  });

  return urls;
}

function isUnsafePreviewHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
  }
  return host === "::1" || host.startsWith("[::1]");
}

function decodeHtml(value = "") {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function cleanPreviewText(value = "") {
  return decodeHtml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function pickMeta(html, names) {
  for (const name of names) {
    const pattern = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i");
    const reversePattern = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["'][^>]*>`, "i");
    const match = html.match(pattern) || html.match(reversePattern);
    if (match?.[1]) return cleanPreviewText(match[1]);
  }
  return "";
}

async function readLimitedResponseText(response, byteLimit) {
  if (!response.body?.getReader) {
    return (await response.text()).slice(0, byteLimit);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (received < byteLimit) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    chunks.push(Buffer.from(value));
  }

  if (received >= byteLimit) {
    await reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function fetchLinkPreview(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) return { ok: false, reason: "unsupported_protocol" };
  if (isUnsafePreviewHost(parsed.hostname)) return { ok: false, reason: "blocked_private_host" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LINK_PREVIEW_TIMEOUT_MS);

  try {
    const response = await fetch(parsed.href, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
    const finalUrl = response.url || parsed.href;
    const html = await readLimitedResponseText(response, LINK_PREVIEW_BYTES);
    const title = cleanPreviewText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
    const description = pickMeta(html, ["description", "og:description", "twitter:description"]);
    const ogTitle = pickMeta(html, ["og:title", "twitter:title"]);
    const keywords = pickMeta(html, ["keywords"]);
    const previewText = [title, ogTitle, description, keywords].filter(Boolean).join(" ");
    const inspection = inspectPlatformUrl(finalUrl);

    return {
      ok: true,
      provider: inspection.provider,
      canAutoFetch: Boolean(previewText),
      reason: previewText ? "ok" : inspection.reason === "platform_login_or_antibot" ? "platform_login_or_antibot" : "metadata_empty",
      finalUrl,
      status: response.status,
      title: ogTitle || title,
      description,
      keywords,
      text: previewText,
    };
  } catch (error) {
    return {
      ok: true,
      provider: inspectPlatformUrl(parsed.href).provider,
      canAutoFetch: false,
      reason: error.name === "AbortError" ? "preview_timeout" : "preview_failed",
      finalUrl: parsed.href,
      title: "",
      description: "",
      keywords: "",
      text: "",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeAiImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter((item) => typeof item === "string")
    .filter((item) => /^data:image\/(png|jpe?g|webp);base64,/i.test(item))
    .filter((item) => item.length <= AI_IMAGE_MAX_LENGTH)
    .slice(0, AI_IMAGE_LIMIT);
}

function getResponseText(data) {
  if (typeof data.output_text === "string") return data.output_text;

  return (data.output || [])
    .flatMap((item) => item.content || [])
    .map((item) => item.text || item.output_text || "")
    .filter(Boolean)
    .join("\n");
}

function normalizeAiExtraction(result, fallbackCity) {
  const attractions = Array.isArray(result?.attractions) ? result.attractions : [];
  const foods = Array.isArray(result?.foods) ? result.foods : [];

  return {
    title: normalizeString(result?.title, 120) || "AI 识别攻略",
    city: normalizeString(result?.city, 60) || fallbackCity || "上海",
    summary: normalizeString(result?.summary, 600),
    attractions: attractions
      .map((item) => ({
        name: normalizeString(item?.name, 80),
        addressHint: normalizeString(item?.addressHint, 160),
        reason: normalizeString(item?.reason, 180),
        confidence: clampConfidence(item?.confidence, 0.7),
      }))
      .filter((item) => item.name)
      .slice(0, 20),
    foods: foods
      .map((item) => ({
        name: normalizeString(item?.name, 80),
        kind: item?.kind === "restaurant" ? "restaurant" : "dish",
        addressHint: normalizeString(item?.addressHint, 160),
        reason: normalizeString(item?.reason, 180),
        confidence: clampConfidence(item?.confidence, 0.7),
      }))
      .filter((item) => item.name)
      .slice(0, 30),
    notes: uniqueStringArray(result?.notes, 12, 180),
    confidence: clampConfidence(result?.confidence, 0.65),
    missingReason: normalizeString(result?.missingReason, 260),
  };
}

async function extractWithOpenAI(payload) {
  if (!OPENAI_API_KEY) {
    return {
      provider: "rules",
      live: false,
      reason: "missing_openai_key",
      model: OPENAI_MODEL,
      result: null,
    };
  }

  const city = normalizeString(payload?.city, 60) || "上海";
  const source = normalizeString(payload?.source, 7000);
  const linkText = normalizeString(payload?.linkText, 2000);
  const ocrText = normalizeString(payload?.ocrText, 4000);
  const mediaText = normalizeString(payload?.mediaText, 1200);
  const images = normalizeAiImages(payload?.images);
  const userText = [
    `默认城市：${city}`,
    source ? `用户粘贴内容：${source}` : "",
    linkText ? `链接标题/描述：${linkText}` : "",
    ocrText ? `截图 OCR：${ocrText}` : "",
    mediaText ? `文件名/媒体线索：${mediaText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const inputContent = [
    {
      type: "input_text",
      text: userText || "用户只上传了图片，请从图片中识别旅行景点、餐厅店名和美食名称。",
    },
    ...images.map((image) => ({
      type: "input_image",
      image_url: image,
      detail: "low",
    })),
  ];

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: "system",
          content:
            "你是美食旅行攻略的信息抽取器。只抽取用户材料中明确出现或图片中能看清的景点、餐厅店名、美食名称、地址线索和注意事项。不要编造没有依据的店名、地点、营业时间或地址。若没有识别到景点、店名或美食，返回空数组，并在 missingReason 说明原因。",
        },
        {
          role: "user",
          content: inputContent,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "shunluchi_extraction",
          strict: true,
          schema: AI_EXTRACTION_SCHEMA,
        },
      },
    }),
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    return {
      provider: "openai",
      live: false,
      reason: data.error?.message || `openai_${response.status}`,
      model: OPENAI_MODEL,
      result: null,
    };
  }

  const text = getResponseText(data);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      provider: "openai",
      live: false,
      reason: "invalid_ai_json",
      model: OPENAI_MODEL,
      result: null,
    };
  }

  return {
    provider: "openai",
    live: true,
    reason: "ok",
    model: OPENAI_MODEL,
    result: normalizeAiExtraction(parsed, city),
  };
}

function applyBaseHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
}

function getPoiKind(poiType = "", requestedKind = "dish") {
  if (requestedKind === "attraction") return "attraction";
  if (poiType.includes("风景名胜") || poiType.includes("科教文化服务")) return "attraction";
  if (poiType.includes("餐饮服务")) return "restaurant";
  return requestedKind;
}

function parseLocation(location = "") {
  const [lng, lat] = location.split(",").map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return {};
  return { lng, lat };
}

function inspectPlatformUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      provider: "unknown",
      canAutoFetch: false,
      reason: "invalid_url",
      stages: {
        link: "invalid",
        image: "manual_upload",
        video: "manual_upload",
        audio: "manual_upload",
      },
    };
  }

  const host = parsed.hostname.toLowerCase();
  const isDouyin = host.includes("douyin.com") || host.includes("iesdouyin.com");
  const isXhs = host.includes("xiaohongshu.com") || host.includes("xhslink.com");

  if (isDouyin || isXhs) {
    return {
      provider: isDouyin ? "douyin" : "xiaohongshu",
      canAutoFetch: false,
      reason: "platform_login_or_antibot",
      stages: {
        link: "needs_authorized_fetch",
        image: "needs_ocr",
        video: "needs_keyframes",
        audio: "needs_asr",
      },
    };
  }

  return {
    provider: "generic",
    canAutoFetch: true,
    reason: "generic_url",
    stages: {
      link: "fetchable_metadata",
      image: "unknown",
      video: "unknown",
      audio: "unknown",
    },
  };
}

function transformPoi(poi, requestedKind, city) {
  const kind = getPoiKind(poi.type, requestedKind);
  const businessArea = poi.business_area || poi.adname || poi.pname || "待确认";
  const opening = poi.biz_ext?.open_time || "高德未返回营业时间";
  const confidence = kind === requestedKind ? 0.92 : 0.82;

  return {
    id: `${kind}-${poi.id || poi.name}`,
    name: poi.name,
    city: poi.cityname || city,
    kind,
    category: poi.type?.split(";").slice(-1)[0] || (kind === "restaurant" ? "餐厅" : "地点"),
    area: businessArea,
    address: poi.address || `${poi.pname || ""}${poi.cityname || ""}${poi.adname || ""}`,
    opening,
    notes: [
      opening === "高德未返回营业时间" ? "营业时间需出发前二次确认" : "营业时间来自高德 POI",
      poi.tel ? `电话：${poi.tel}` : "暂无电话信息",
    ],
    confidence,
    source: "高德 POI",
    ...parseLocation(poi.location),
  };
}

async function searchAmap({ keywords, city, kind }) {
  if (!AMAP_KEY) {
    return {
      provider: "mock",
      live: false,
      reason: "missing_amap_key",
      entity: null,
    };
  }

  const params = new URLSearchParams({
    key: AMAP_KEY,
    keywords,
    city,
    offset: "5",
    page: "1",
    extensions: "all",
  });

  const url = `https://restapi.amap.com/v3/place/text?${params.toString()}`;
  const response = await fetch(url);
  const data = await response.json();

  if (data.status !== "1") {
    return {
      provider: "amap",
      live: false,
      reason: data.info || "amap_error",
      entity: null,
    };
  }

  const poi = Array.isArray(data.pois) ? data.pois[0] : null;
  return {
    provider: "amap",
    live: true,
    reason: poi ? "ok" : "empty",
    entity: poi ? transformPoi(poi, kind, city) : null,
  };
}

function cleanExtractCandidate(value = "") {
  return normalizeString(value, 80)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[【】《》「」『』#@]/g, " ")
    .replace(/^[\s，。；、,.!！?？:：-]+/, "")
    .replace(/^(今天|明天|昨天|周末|上午|中午|下午|晚上|早上|凌晨|先|再|然后|最后|顺路|附近|推荐|打卡|去|逛|玩|吃|喝|试试|想吃|想去|来到|到了|在|从|到|一家|这家|那家|一个|小红书|抖音|视频|截图)+/i, "")
    .replace(/(真的|特别|非常|很好吃|好吃|不错|排队|必吃|推荐|打卡|附近|路线|攻略|分享|收藏|避雷|人均|左右)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function collectExtractMatches(text, pattern) {
  const matches = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const candidate = cleanExtractCandidate(match[1] || match[0]);
    if (!candidate || candidate.length < 2) continue;
    const parts = candidate
      .split(/[和与及、,，/]+/)
      .map(cleanExtractCandidate)
      .filter((item) => item.length >= 2);
    if (parts.length > 1) {
      parts.forEach((item) => matches.push(item));
    } else {
      matches.push(candidate);
    }
  }
  return uniqueStringArray(matches, 16, 80);
}

function extractAmapCandidates(text) {
  const cleanText = normalizeString(text, 9000);
  const attractionCandidates = collectExtractMatches(
    cleanText,
    /([\u4e00-\u9fa5A-Za-z0-9·&' -]{2,28}(?:博物馆|美术馆|纪念馆|公园|景区|古镇|古城|寺|塔|山|湖|海滩|外滩|园区|乐园|迪士尼|广场|商圈|步行街|老街|夜市|路|街|巷|弄|村|岛|湾|展览))/g,
  );
  const restaurantCandidates = collectExtractMatches(
    cleanText,
    /([\u4e00-\u9fa5A-Za-z0-9·&' -]{2,30}(?:餐厅|菜馆|饭店|酒楼|面馆|粉店|小笼|生煎|咖啡|Coffee|Cafe|cafe|火锅|烤肉|烧烤|小吃|甜品|茶餐厅|面包|酒馆|食堂|料理|寿司|拉面|串串|牛肉|羊肉|鸡煲|酸菜鱼|烤鱼|店))/gi,
  );
  const dishKeywords = [
    "小笼包",
    "蟹黄面",
    "本帮菜",
    "生煎",
    "火锅",
    "咖啡",
    "早茶",
    "肠粉",
    "烧鹅",
    "奶茶",
    "甜品",
    "烤肉",
    "日料",
    "寿司",
    "串串",
    "牛肉面",
    "螺蛳粉",
    "米粉",
    "馄饨",
    "锅贴",
    "包子",
    "杭帮菜",
    "川菜",
    "粤菜",
  ].filter((item) => cleanText.includes(item));

  return {
    attractions: attractionCandidates,
    restaurants: restaurantCandidates,
    dishes: uniqueStringArray(dishKeywords, 20, 40),
  };
}

async function validateCandidatesWithAmap(candidates, city, kind) {
  const validated = [];
  const seen = new Set();

  for (const name of candidates.slice(0, 10)) {
    try {
      const result = await searchAmap({ keywords: name, city, kind });
      if (!result.entity) continue;
      const key = `${result.entity.kind}:${result.entity.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      validated.push({
        name: result.entity.name,
        kind: result.entity.kind,
        addressHint: result.entity.address,
        reason: `由“${name}”经高德 POI 校验`,
        confidence: result.live ? result.entity.confidence : 0.62,
      });
    } catch {
      // Candidate validation is best-effort; skip noisy matches.
    }
  }

  return validated;
}

async function extractWithAmapRules(payload) {
  const city = normalizeString(payload?.city, 60) || "上海";
  const source = normalizeString(payload?.source, 7000);
  const ocrText = normalizeString(payload?.ocrText, 4000);
  const mediaText = normalizeString(payload?.mediaText, 1200);
  const combinedText = [source, ocrText, mediaText].filter(Boolean).join("\n");
  const candidates = extractAmapCandidates(combinedText);
  const [validatedAttractions, validatedRestaurants] = await Promise.all([
    validateCandidatesWithAmap(candidates.attractions, city, "attraction"),
    validateCandidatesWithAmap(candidates.restaurants, city, "restaurant"),
  ]);
  const attractions = validatedAttractions.filter((item) => item.kind === "attraction");
  const restaurantFoods = validatedRestaurants.map((item) => ({
    ...item,
    kind: "restaurant",
  }));
  const dishes = candidates.dishes.map((name) => ({
    name,
    kind: "dish",
    addressHint: "",
    reason: "从文案/OCR 中识别到的美食偏好",
    confidence: 0.72,
  }));

  return {
    provider: AMAP_KEY ? "amap_extract" : "rules",
    live: Boolean(AMAP_KEY),
    reason: combinedText ? "ok" : "empty_input",
    result: {
      title: source.slice(0, 28) || ocrText.slice(0, 28) || "文案截图识别",
      city,
      summary: combinedText.slice(0, 180),
      attractions,
      foods: [...restaurantFoods, ...dishes].slice(0, 30),
      notes: [
        AMAP_KEY ? "景点和店名已通过高德 POI 尝试校验" : "未配置高德 Key，使用本地规则识别",
        ocrText ? "已合并截图 OCR 文字" : "可上传截图提高识别范围",
        "营业时间和地址以高德补全结果为准，出发前建议再次确认",
      ],
      confidence: attractions.length || restaurantFoods.length ? 0.82 : dishes.length ? 0.68 : 0.4,
      missingReason: attractions.length || restaurantFoods.length || dishes.length ? "" : "未识别到明确的景点、店名或美食名称",
    },
  };
}

async function serveStatic(req, res, pathname) {
  const normalized = pathname === "/" || pathname === "/app" || pathname === "/app/" ? "/index.html" : pathname;
  const filePath = path.join(ROOT, normalized);
  const relative = path.relative(ROOT, filePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    applyBaseHeaders(res);
    res.writeHead(200, {
      "content-type": contentTypes[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=300",
    });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  applyBaseHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, x-shunluchi-space",
    });
    res.end();
    return;
  }

  if (url.pathname === "/api/status") {
    sendJson(res, 200, {
      ok: true,
      provider: AMAP_KEY ? "amap" : "mock",
      hasAmapKey: Boolean(AMAP_KEY),
      aiProvider: OPENAI_API_KEY ? "openai" : AMAP_KEY ? "amap_extract" : "rules",
      hasOpenAiKey: Boolean(OPENAI_API_KEY),
      aiModel: OPENAI_MODEL,
      localUrl: `http://127.0.0.1:${PORT}/app`,
      lanUrls: getLanUrls(),
    });
    return;
  }

  if (url.pathname === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      service: "shunluchi",
      uptime: Math.round(process.uptime()),
    });
    return;
  }

  if (url.pathname === "/api/library") {
    const librarySpace = getLibrarySpace(req, url);

    if (req.method === "GET") {
      const store = await readLibraryStore(librarySpace);
      sendJson(res, 200, { ok: true, ...store });
      return;
    }

    if (req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const store = await replaceCloudLibrary(body.library, librarySpace);
        sendJson(res, 200, { ok: true, ...store });
      } catch (error) {
        const status = error.message === "payload_too_large" ? 413 : 400;
        sendJson(res, status, { ok: false, reason: error.message || "bad_request" });
      }
      return;
    }

    if (req.method === "DELETE") {
      const store = await writeLibraryStore([], librarySpace);
      sendJson(res, 200, { ok: true, ...store });
      return;
    }
  }

  if (url.pathname === "/api/library/entry") {
    const librarySpace = getLibrarySpace(req, url);

    if (req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const store = await upsertCloudEntry(body.entry, librarySpace);
        if (!store) {
          sendJson(res, 400, { ok: false, reason: "empty_entry" });
          return;
        }
        sendJson(res, 200, { ok: true, ...store });
      } catch (error) {
        const status = error.message === "payload_too_large" ? 413 : 400;
        sendJson(res, status, { ok: false, reason: error.message || "bad_request" });
      }
      return;
    }

    if (req.method === "DELETE") {
      const id = normalizeString(url.searchParams.get("id"), 160);
      if (!id) {
        sendJson(res, 400, { ok: false, reason: "missing_id" });
        return;
      }
      const store = await deleteCloudEntry(id, librarySpace);
      sendJson(res, 200, { ok: true, ...store });
      return;
    }
  }

  if (url.pathname === "/api/link/inspect") {
    const target = url.searchParams.get("url") || "";
    sendJson(res, 200, {
      ok: true,
      ...inspectPlatformUrl(target),
    });
    return;
  }

  if (url.pathname === "/api/link/preview") {
    const target = url.searchParams.get("url") || "";
    const preview = await fetchLinkPreview(target);
    sendJson(res, preview.ok === false ? 400 : 200, preview.ok === false ? { ok: false, ...preview } : { ok: true, ...preview });
    return;
  }

  if (url.pathname === "/api/ai/extract") {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("Method not allowed");
      return;
    }

    try {
      const body = await readRequestJson(req);
      const extraction = await extractWithOpenAI(body);
      sendJson(res, 200, { ok: true, ...extraction });
    } catch (error) {
      const status = error.message === "payload_too_large" ? 413 : 200;
      sendJson(res, status, {
        ok: true,
        provider: OPENAI_API_KEY ? "openai" : "rules",
        live: false,
        reason: error.message || "ai_extract_failed",
        model: OPENAI_MODEL,
        result: null,
      });
    }
    return;
  }

  if (url.pathname === "/api/poi/extract") {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("Method not allowed");
      return;
    }

    try {
      const body = await readRequestJson(req);
      const extraction = await extractWithAmapRules(body);
      sendJson(res, 200, { ok: true, ...extraction });
    } catch (error) {
      const status = error.message === "payload_too_large" ? 413 : 200;
      sendJson(res, status, {
        ok: true,
        provider: AMAP_KEY ? "amap_extract" : "rules",
        live: false,
        reason: error.message || "poi_extract_failed",
        result: null,
      });
    }
    return;
  }

  if (url.pathname === "/api/amap/search") {
    const keywords = url.searchParams.get("keywords") || "";
    const city = url.searchParams.get("city") || "上海";
    const kind = url.searchParams.get("kind") || "dish";

    if (!keywords.trim()) {
      sendJson(res, 400, { ok: false, reason: "missing_keywords" });
      return;
    }

    try {
      const result = await searchAmap({ keywords, city, kind });
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 200, {
        ok: true,
        provider: "mock",
        live: false,
        reason: error.message || "network_error",
        entity: null,
      });
    }
    return;
  }

  if (url.pathname === "/api/amap/route") {
    const origin = url.searchParams.get("origin") || "";
    const destination = url.searchParams.get("destination") || "";
    const type = url.searchParams.get("type") || "walking";

    if (!origin || !destination) {
      sendJson(res, 400, { ok: false, reason: "missing_origin_or_destination" });
      return;
    }

    if (!/^[\d.]+,[\d.]+$/.test(origin) || !/^[\d.]+,[\d.]+$/.test(destination)) {
      sendJson(res, 400, { ok: false, reason: "invalid_coordinate_format" });
      return;
    }

    if (!["walking", "driving", "bicycling", "transit"].includes(type)) {
      sendJson(res, 400, { ok: false, reason: "invalid_route_type" });
      return;
    }

    if (!AMAP_KEY) {
      sendJson(res, 200, { ok: true, provider: "mock", live: false, reason: "missing_amap_key", route: null });
      return;
    }

    try {
      const params = new URLSearchParams({ key: AMAP_KEY, origin, destination });
      const amapUrl = `https://restapi.amap.com/v3/direction/${type}?${params.toString()}`;
      const response = await fetch(amapUrl);
      const data = await response.json();

      if (data.status !== "1") {
        sendJson(res, 200, { ok: true, provider: "amap", live: false, reason: data.info || "amap_error", route: null });
        return;
      }

      const path = data.route?.paths?.[0];
      if (!path) {
        sendJson(res, 200, { ok: true, provider: "amap", live: true, reason: "empty", route: null });
        return;
      }

      // Transit routes have a different structure with segments
      if (type === "transit") {
        const segments = (path.segments || []).map((seg) => {
          const busInfo = seg.bus?.buslines?.[0];
          const walkingInfo = seg.walking;
          const isWalking = !busInfo;
          return {
            mode: isWalking ? "walking" : (busInfo.type?.includes("地铁") ? "subway" : "bus"),
            name: busInfo?.name || "",
            departure: busInfo?.departure_stop?.name || seg.walking?.origin || "",
            arrival: busInfo?.arrival_stop?.name || seg.walking?.destination || "",
            distance: isWalking ? (walkingInfo?.distance || 0) : (busInfo?.distance || 0),
            duration: isWalking ? (walkingInfo?.duration || 0) : (busInfo?.duration || 0),
            stationCount: busInfo?.via_num || 0,
            instruction: seg.walking?.steps?.[0]?.instruction?.replace(/<[^>]+>/g, "") || "",
          };
        });

        sendJson(res, 200, {
          ok: true,
          provider: "amap",
          live: true,
          reason: "ok",
          route: {
            distance: path.distance,
            duration: path.duration,
            cost: path.cost || 0,
            origin: { lng: Number(origin.split(",")[0]), lat: Number(origin.split(",")[1]) },
            destination: { lng: Number(destination.split(",")[0]), lat: Number(destination.split(",")[1]) },
            segments,
            steps: [],
          },
        });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        provider: "amap",
        live: true,
        reason: "ok",
        route: {
          distance: path.distance,
          duration: path.duration,
          origin: { lng: Number(origin.split(",")[0]), lat: Number(origin.split(",")[1]) },
          destination: { lng: Number(destination.split(",")[0]), lat: Number(destination.split(",")[1]) },
          steps: (path.steps || []).map((step) => ({
            instruction: step.instruction?.replace(/<[^>]+>/g, "") || "",
            road: step.road || "",
            distance: step.distance,
            duration: step.duration,
            polyline: step.polyline || "",
          })),
        },
      });
    } catch (error) {
      sendJson(res, 200, {
        ok: true,
        provider: "mock",
        live: false,
        reason: error.message || "route_fetch_failed",
        route: null,
      });
    }
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  try {
    await serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { ok: false, reason: "internal_server_error" });
  }
});

server.on("error", (error) => {
  console.error("服务启动失败：", error);
  process.exitCode = 1;
});

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, HOST, () => {
  const mode = AMAP_KEY ? "高德 POI 已启用" : "未配置 AMAP_KEY，使用模拟 POI";
  console.log(`顺路吃服务已启动：http://127.0.0.1:${PORT}`);
  getLanUrls().forEach((lanUrl) => {
    console.log(`局域网访问：${lanUrl}`);
  });
  console.log(mode);
});
