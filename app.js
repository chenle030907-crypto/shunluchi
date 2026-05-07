const LIBRARY_STORAGE_KEY = "shunluchi.recognitionLibrary.v1";
const CLOUD_SPACE_STORAGE_KEY = "shunluchi.cloudSpace.v1";
const API_BASE = window.location.protocol === "file:" ? "http://127.0.0.1:4173" : "";
const CLOUD_LIBRARY_LIMIT = 50;
const TESSERACT_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
const AI_IMAGE_LIMIT = 3;
const AI_IMAGE_MAX_SIDE = 1280;
let tesseractLoader = null;

function normalizeCloudSpaceId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 32);
}

function createCloudSpaceId() {
  const bytes = new Uint8Array(8);
  if (window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    bytes.forEach((_, index) => {
      bytes[index] = Math.floor(Math.random() * 256);
    });
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function resolveCloudSpaceId() {
  const fromUrl = normalizeCloudSpaceId(new URLSearchParams(window.location.search).get("space"));
  if (fromUrl) {
    localStorage.setItem(CLOUD_SPACE_STORAGE_KEY, fromUrl);
    return fromUrl;
  }

  const fromStorage = normalizeCloudSpaceId(localStorage.getItem(CLOUD_SPACE_STORAGE_KEY));
  if (fromStorage) return fromStorage;

  const nextSpace = createCloudSpaceId();
  localStorage.setItem(CLOUD_SPACE_STORAGE_KEY, nextSpace);
  return nextSpace;
}

const CLOUD_SPACE_ID = resolveCloudSpaceId();

if ("serviceWorker" in navigator && window.location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("Service worker 注册失败。", error);
    });
  });
}

function loadLibrary() {
  try {
    const raw = localStorage.getItem(LIBRARY_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (error) {
    console.warn("资料库读取失败，已切换为空资料库。", error);
    return [];
  }
}

function saveLibrary() {
  try {
    localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(state.library));
  } catch (error) {
    console.warn("资料库保存失败。", error);
  }
}

function setCloudSyncStatus(kind, text) {
  state.cloudSync = kind;
  if (!els.cloudSyncStatus) return;
  els.cloudSyncStatus.className = `status-pill sync-${kind}`;
  els.cloudSyncStatus.textContent = text;
}

function getCloudHeaders() {
  return {
    "content-type": "application/json",
    "x-shunluchi-space": CLOUD_SPACE_ID,
  };
}

function getCloudShareUrl() {
  const baseUrl = window.location.protocol === "file:" ? `${API_BASE}/app` : window.location.href;
  const url = new URL(baseUrl);
  url.pathname = "/app";
  url.searchParams.set("space", CLOUD_SPACE_ID);
  return url.href;
}

function getLibraryEntryKey(entry) {
  return entry.fingerprint || entry.id || `${entry.city}|${entry.source}|${entry.attractions?.join(",")}|${entry.foods?.join(",")}`;
}

function mergeLibraryEntries(primary = [], secondary = []) {
  const byKey = new Map();

  [...primary, ...secondary].forEach((entry) => {
    const hydrated = hydrateEntry(entry);
    if (!hasExtractedContent(hydrated)) return;

    const key = getLibraryEntryKey(hydrated);
    const existing = byKey.get(key);
    const currentTime = new Date(hydrated.createdAt).getTime();
    const existingTime = existing ? new Date(existing.createdAt).getTime() : 0;

    if (!existing || currentTime >= existingTime) {
      byKey.set(key, hydrated);
    }
  });

  return [...byKey.values()]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, CLOUD_LIBRARY_LIMIT);
}

async function syncLibraryToCloud(reason = "save") {
  setCloudSyncStatus("syncing", "云端同步中");

  try {
    const response = await fetch(`${API_BASE}/api/library`, {
      method: "POST",
      headers: getCloudHeaders(),
      body: JSON.stringify({ library: state.library.map(hydrateEntry) }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.reason || "sync_failed");

    state.library = mergeLibraryEntries(data.library || [], []);
    saveLibrary();
    setCloudSyncStatus("live", reason === "clear" ? "云端已清空" : "云端已同步");
    render();
  } catch (error) {
    console.warn("云端资料库同步失败。", error);
    setCloudSyncStatus("offline", "本地缓存");
  }
}

async function loadCloudLibrary() {
  setCloudSyncStatus("syncing", "读取云端");

  try {
    const response = await fetch(`${API_BASE}/api/library`, {
      cache: "no-store",
      headers: { "x-shunluchi-space": CLOUD_SPACE_ID },
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.reason || "load_failed");

    const cloudLibrary = Array.isArray(data.library) ? data.library : [];
    const mergedLibrary = mergeLibraryEntries(cloudLibrary, state.library);
    const cloudKeys = new Set(cloudLibrary.map(getLibraryEntryKey));
    const needsUpload = mergedLibrary.some((entry) => !cloudKeys.has(getLibraryEntryKey(entry)));

    state.library = mergedLibrary;
    saveLibrary();
    setCloudSyncStatus("live", "云端已同步");
    render();

    if (needsUpload) syncLibraryToCloud("merge");
  } catch (error) {
    console.warn("云端资料库读取失败。", error);
    setCloudSyncStatus("offline", "本地缓存");
  }
}

const state = {
  activeAttractionId: "museum",
  activeMeal: "lunch",
  openOnly: true,
  walkLimit: 15,
  library: loadLibrary(),
  cloudSync: "checking",
  apiProvider: "checking",
  apiLive: false,
  lanUrl: "",
  importedMedia: [],
  ocrResults: [],
  ocrStatus: "idle",
  aiProvider: "checking",
  linkInspection: null,
  linkPreview: null,
  pendingEntry: null,
  attractions: [
    {
      id: "museum",
      name: "上海博物馆",
      area: "人民广场",
      address: "黄浦区人民大道 201 号",
      lng: 121.4737,
      lat: 31.2304,
      x: 32,
      y: 36,
    },
    {
      id: "wukang",
      name: "武康路",
      area: "徐汇区",
      address: "徐汇区武康路历史文化名街",
      lng: 121.4380,
      lat: 31.2071,
      x: 38,
      y: 58,
    },
    {
      id: "bund",
      name: "外滩",
      area: "黄浦区",
      address: "中山东一路",
      lng: 121.4907,
      lat: 31.2400,
      x: 70,
      y: 40,
    },
  ],
  foods: ["小笼包", "蟹黄面", "咖啡", "本帮菜"],
};

const foodDatabase = [
  {
    id: “lailai”,
    name: “莱莱小笼”,
    match: [“小笼包”],
    category: “小笼包”,
    area: “人民广场”,
    address: “黄浦区广西北路附近”,
    opening: “07:00-20:30”,
    meals: [“breakfast”, “lunch”],
    open: true,
    price: “人均 45”,
    lng: 121.4752,
    lat: 31.2356,
    note: “热门时段排队明显，建议错峰或先取号。”,
    reason: “和你的”小笼包”愿望高度匹配，适合上海博物馆前后安排。”,
    distances: {
      museum: { walk: 9, drive: 5, x: 46, y: 43 },
      wukang: { walk: 34, drive: 18, x: 58, y: 46 },
      bund: { walk: 21, drive: 11, x: 62, y: 46 },
    },
  },
  {
    id: “an-niang”,
    name: “阿娘面馆”,
    match: [“蟹黄面”, “面”],
    category: “面馆”,
    area: “淮海路”,
    address: “黄浦区思南路附近”,
    opening: “10:30-14:00, 17:00-20:00”,
    meals: [“lunch”, “dinner”],
    open: true,
    price: “人均 60”,
    lng: 121.4650,
    lat: 31.2168,
    note: “午饭档更稳，晚上可能提前售罄。”,
    reason: “适合把武康路和淮海路连成半日逛吃线。”,
    distances: {
      museum: { walk: 22, drive: 12, x: 45, y: 54 },
      wukang: { walk: 13, drive: 8, x: 48, y: 62 },
      bund: { walk: 35, drive: 17, x: 54, y: 52 },
    },
  },
  {
    id: “rac”,
    name: “RAC Coffee”,
    match: [“咖啡”, “早午餐”],
    category: “咖啡/早午餐”,
    area: “武康路”,
    address: “徐汇区安福路附近”,
    opening: “08:00-22:00”,
    meals: [“breakfast”, “tea”],
    open: true,
    price: “人均 90”,
    lng: 121.4375,
    lat: 31.2120,
    note: “周末下午座位紧张，适合工作日或早一点去。”,
    reason: “离武康路近，逛累了可以直接切到下午茶。”,
    distances: {
      museum: { walk: 31, drive: 16, x: 36, y: 66 },
      wukang: { walk: 8, drive: 5, x: 42, y: 70 },
      bund: { walk: 42, drive: 22, x: 44, y: 67 },
    },
  },
  {
    id: “benbang”,
    name: “茂隆餐厅”,
    match: [“本帮菜”, “红烧肉”],
    category: “本帮菜”,
    area: “南京西路”,
    address: “静安区南京西路附近”,
    opening: “11:00-14:00, 17:00-21:00”,
    meals: [“lunch”, “dinner”],
    open: true,
    price: “人均 120”,
    lng: 121.4560,
    lat: 31.2308,
    note: “更适合 2 人以上点菜，提前电话确认排队情况。”,
    reason: “本帮菜匹配度高，适合博物馆或外滩之后打车过去。”,
    distances: {
      museum: { walk: 16, drive: 9, x: 39, y: 28 },
      wukang: { walk: 25, drive: 13, x: 42, y: 34 },
      bund: { walk: 30, drive: 14, x: 55, y: 31 },
    },
  },
  {
    id: “crab”,
    name: “蟹尊苑”,
    match: [“蟹黄面”, “蟹粉”],
    category: “蟹黄面”,
    area: “南京东路”,
    address: “黄浦区南京东路商圈”,
    opening: “11:00-21:00”,
    meals: [“lunch”, “dinner”],
    open: true,
    price: “人均 160”,
    lng: 121.4823,
    lat: 31.2387,
    note: “价格偏高，适合把它当成当天重点餐。”,
    reason: “如果今晚去外滩，看夜景前吃蟹黄面路线很顺。”,
    distances: {
      museum: { walk: 18, drive: 8, x: 58, y: 34 },
      wukang: { walk: 39, drive: 20, x: 62, y: 42 },
      bund: { walk: 10, drive: 6, x: 76, y: 35 },
    },
  },
  {
    id: “night”,
    name: “老正兴菜馆”,
    match: [“本帮菜”],
    category: “老字号本帮菜”,
    area: “豫园”,
    address: “黄浦区福佑路附近”,
    opening: “10:30-20:30”,
    meals: [“lunch”, “dinner”],
    open: false,
    price: “人均 110”,
    lng: 121.4945,
    lat: 31.2282,
    note: “原型中标记为暂不可用，用来展示”只看当前营业”过滤。”,
    reason: “靠近外滩和豫园，适合作为传统上海菜备选。”,
    distances: {
      museum: { walk: 24, drive: 11, x: 63, y: 52 },
      wukang: { walk: 43, drive: 24, x: 57, y: 57 },
      bund: { walk: 14, drive: 7, x: 72, y: 54 },
    },
  },
];

const poiKnowledgeBase = {
  上海博物馆: {
    kind: "attraction",
    category: "博物馆",
    area: "人民广场",
    address: "黄浦区人民大道 201 号",
    opening: "09:00-17:00（周一通常闭馆）",
    notes: ["热门展览需预约", "建议预留 1.5 到 2 小时", "出发前确认当日开放状态"],
    confidence: 0.94,
    source: "地图补全模拟",
    lng: 121.4737,
    lat: 31.2304,
    x: 32,
    y: 36,
  },
  武康路: {
    kind: "attraction",
    category: "历史街区",
    area: "徐汇区",
    address: "徐汇区武康路历史文化名街",
    opening: "全天开放",
    notes: ["适合步行拍照", "周末下午人多", "可顺路安福路和淮海中路"],
    confidence: 0.92,
    source: "地图补全模拟",
    lng: 121.4380,
    lat: 31.2071,
    x: 38,
    y: 58,
  },
  外滩: {
    kind: "attraction",
    category: "城市地标",
    area: "黄浦区",
    address: "中山东一路",
    opening: "全天开放",
    notes: ["夜景更好看", "节假日人流密集", "注意返程交通高峰"],
    confidence: 0.93,
    source: "地图补全模拟",
    lng: 121.4907,
    lat: 31.2400,
    x: 70,
    y: 40,
  },
  田子坊: {
    kind: "attraction",
    category: "街区",
    area: "黄浦区",
    address: "泰康路 210 弄附近",
    opening: "多数店铺约 10:00-22:00",
    notes: ["店铺营业时间不完全一致", "适合拍照和买伴手礼", "晚间更热闹"],
    confidence: 0.86,
    source: "地图补全模拟",
    lng: 121.4692,
    lat: 31.2093,
    x: 46,
    y: 60,
  },
  豫园: {
    kind: "attraction",
    category: "园林/商圈",
    area: "黄浦区",
    address: "黄浦区福佑路 168 号附近",
    opening: "园区约 09:00-16:30，商圈更晚",
    notes: ["园林和商圈开放时间不同", "节假日客流大", "适合和外滩同日安排"],
    confidence: 0.88,
    source: "地图补全模拟",
    lng: 121.4925,
    lat: 31.2274,
    x: 64,
    y: 54,
  },
  莱莱小笼: {
    kind: "restaurant",
    category: "小笼包",
    area: "人民广场",
    address: "黄浦区广西北路附近",
    opening: "07:00-20:30",
    notes: ["热门时段排队明显", "适合早餐或午餐", "建议错峰或先取号"],
    confidence: 0.89,
    source: "地图补全模拟",
    lng: 121.4752,
    lat: 31.2356,
    x: 46,
    y: 43,
  },
  阿娘面馆: {
    kind: "restaurant",
    category: "面馆",
    area: "淮海路",
    address: "黄浦区思南路附近",
    opening: "10:30-14:00, 17:00-20:00",
    notes: ["午饭档更稳", "晚上可能提前售罄", "适合接武康路路线"],
    confidence: 0.87,
    source: "地图补全模拟",
    lng: 121.4650,
    lat: 31.2168,
    x: 48,
    y: 62,
  },
  "RAC Coffee": {
    kind: "restaurant",
    category: "咖啡/早午餐",
    area: "武康路",
    address: "徐汇区安福路附近",
    opening: "08:00-22:00",
    notes: ["周末下午座位紧张", "适合下午茶", "工作日体验更稳"],
    confidence: 0.9,
    source: "地图补全模拟",
    lng: 121.4375,
    lat: 31.2120,
    x: 42,
    y: 70,
  },
  蟹尊苑: {
    kind: "restaurant",
    category: "蟹黄面",
    area: "南京东路",
    address: "黄浦区南京东路商圈",
    opening: "11:00-21:00",
    notes: ["价格偏高", "适合作为重点餐", "节假日建议预约或错峰"],
    confidence: 0.86,
    source: "地图补全模拟",
    lng: 121.4823,
    lat: 31.2387,
    x: 76,
    y: 35,
  },
  茂隆餐厅: {
    kind: "restaurant",
    category: "本帮菜",
    area: "南京西路",
    address: "静安区南京西路附近",
    opening: "11:00-14:00, 17:00-21:00",
    notes: ["适合 2 人以上点菜", "提前确认排队情况", "晚餐更适合慢慢吃"],
    confidence: 0.84,
    source: "地图补全模拟",
    lng: 121.4560,
    lat: 31.2308,
    x: 39,
    y: 28,
  },
};

const dishKnowledgeBase = {
  小笼包: { category: "上海小吃", notes: ["适合早餐或午餐", "优先匹配小笼包店"] },
  蟹黄面: { category: "面食", notes: ["价格波动大", "适合作为当天重点餐"] },
  咖啡: { category: "饮品/下午茶", notes: ["适合穿插在步行街区", "下午茶时段更匹配"] },
  本帮菜: { category: "上海菜", notes: ["适合午餐或晚餐", "多人点菜体验更好"] },
  生煎: { category: "上海小吃", notes: ["适合早餐或午餐", "外带也方便"] },
  火锅: { category: "正餐", notes: ["用餐时间较长", "晚餐更适合"] },
};

const mealLabels = {
  breakfast: "早餐",
  lunch: "午餐",
  tea: "下午茶",
  dinner: "晚餐",
};

const els = {
  sourceInput: document.querySelector("#sourceInput"),
  extractBtn: document.querySelector("#extractBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  extractionBox: document.querySelector("#extractionBox"),
  inspectLinkBtn: document.querySelector("#inspectLinkBtn"),
  mediaInput: document.querySelector("#mediaInput"),
  mediaList: document.querySelector("#mediaList"),
  resolverGrid: document.querySelector("#resolverGrid"),
  attractionInput: document.querySelector("#attractionInput"),
  foodInput: document.querySelector("#foodInput"),
  addAttractionBtn: document.querySelector("#addAttractionBtn"),
  addFoodBtn: document.querySelector("#addFoodBtn"),
  attractionList: document.querySelector("#attractionList"),
  foodList: document.querySelector("#foodList"),
  selectedPlace: document.querySelector("#selectedPlace"),
  recommendList: document.querySelector("#recommendList"),
  mapCanvas: document.querySelector("#mapCanvas"),
  itinerary: document.querySelector("#itinerary"),
  mealTabs: document.querySelector("#mealTabs"),
  openOnly: document.querySelector("#openOnly"),
  walkLimit: document.querySelector("#walkLimit"),
  tripDate: document.querySelector("#tripDate"),
  routeBtn: document.querySelector("#routeBtn"),
  libraryCount: document.querySelector("#libraryCount"),
  libraryList: document.querySelector("#libraryList"),
  cloudSyncStatus: document.querySelector("#cloudSyncStatus"),
  copyCloudLinkBtn: document.querySelector("#copyCloudLinkBtn"),
  exportLibraryBtn: document.querySelector("#exportLibraryBtn"),
  clearLibraryBtn: document.querySelector("#clearLibraryBtn"),
  refreshPoiBtn: document.querySelector("#refreshPoiBtn"),
  entitySummary: document.querySelector("#entitySummary"),
  entityList: document.querySelector("#entityList"),
  apiStatus: document.querySelector("#apiStatus"),
  copyLanUrlBtn: document.querySelector("#copyLanUrlBtn"),
};

function normalizeId(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\u4e00-\u9fa5a-z0-9-]/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function getLocalDateInputValue(date = new Date()) {
  const timezoneOffsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - timezoneOffsetMs).toISOString().slice(0, 10);
}

function setDefaultTripDate() {
  if (els.tripDate && !els.tripDate.value) {
    els.tripDate.value = getLocalDateInputValue();
  }
}

function extractFirstUrl(text) {
  const match = text.match(/https?:\/\/[^\s，。；、)）]+/i);
  return match ? match[0] : "";
}

function getMediaSignature(item) {
  return `${item.name}:${item.size}`;
}

function getMediaSignalText() {
  const fileNameText = state.importedMedia.map((item) => item.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ")).join(" ");
  const ocrText = state.ocrResults.map((item) => item.text).filter(Boolean).join(" ");
  return [fileNameText, ocrText].filter(Boolean).join(" ");
}

function getLinkSignalText() {
  if (!state.linkPreview) return "";
  return [state.linkPreview.title, state.linkPreview.description, state.linkPreview.keywords, state.linkPreview.text].filter(Boolean).join(" ");
}

function getSourceTitle(source) {
  const url = extractFirstUrl(source);
  if (!url) return source.trim().slice(0, 24) || "手动输入";
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function getLocalLinkInspection(url) {
  if (!url) {
    return {
      provider: "none",
      canAutoFetch: false,
      reason: "missing_url",
      stages: { link: "empty", image: "manual_upload", video: "manual_upload", audio: "manual_upload" },
    };
  }

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isDouyin = host.includes("douyin.com") || host.includes("iesdouyin.com");
    const isXhs = host.includes("xiaohongshu.com") || host.includes("xhslink.com");

    if (isDouyin || isXhs) {
      return {
        provider: isDouyin ? "douyin" : "xiaohongshu",
        canAutoFetch: false,
        reason: "platform_login_or_antibot",
        stages: { link: "needs_authorized_fetch", image: "needs_ocr", video: "needs_keyframes", audio: "needs_asr" },
      };
    }

    return {
      provider: "generic",
      canAutoFetch: true,
      reason: "generic_url",
      stages: { link: "fetchable_metadata", image: "unknown", video: "unknown", audio: "unknown" },
    };
  } catch {
    return {
      provider: "unknown",
      canAutoFetch: false,
      reason: "invalid_url",
      stages: { link: "invalid", image: "manual_upload", video: "manual_upload", audio: "manual_upload" },
    };
  }
}

function getInspectionLabel(inspection) {
  if (!inspection || inspection.reason === "missing_url") return "待检测";
  if (state.linkPreview?.canAutoFetch) return "已抓到标题";
  if (inspection.canAutoFetch) return "可抓元数据";
  if (inspection.reason === "platform_login_or_antibot") return "需授权/上传";
  if (inspection.reason === "invalid_url") return "链接无效";
  return "需后端解析";
}

function getTextInputStatus() {
  const text = els.sourceInput.value.trim();
  if (!text) return "待输入";
  return `${Math.min(99, Math.ceil(text.length / 20))} 段线索`;
}

function updateResolverCard(stage, status, tone = "") {
  const card = els.resolverGrid.querySelector(`[data-stage="${stage}"]`);
  if (!card) return;
  card.classList.remove("ready", "blocked");
  if (tone) card.classList.add(tone);
  card.querySelector("span").textContent = status;
}

function renderResolverStatus() {
  const images = state.importedMedia.filter((item) => item.type.startsWith("image/"));
  const videos = state.importedMedia.filter((item) => item.type.startsWith("video/"));
  const ocrDone = images.length && state.ocrResults.some((item) => item.text);
  const ocrFailed = images.length && state.ocrStatus === "failed";
  const ocrStatus = state.ocrStatus === "running" ? "OCR 中" : ocrDone ? "OCR 已完成" : ocrFailed ? "OCR 失败" : images.length ? `${images.length} 张待 OCR` : "未上传";

  updateResolverCard("text", getTextInputStatus(), els.sourceInput.value.trim() ? "ready" : "");
  updateResolverCard("ocr", ocrStatus, images.length && !ocrFailed ? "ready" : ocrFailed ? "blocked" : "");
  updateResolverCard("frame", videos.length ? `${videos.length} 个视频` : "未上传", videos.length ? "ready" : "");
  updateResolverCard("audio", videos.length ? "待 ASR" : "未上传", videos.length ? "ready" : "");
}

function renderMediaList() {
  renderResolverStatus();

  if (!state.importedMedia.length) {
    els.mediaList.innerHTML = `<span class="muted">可上传探店截图、菜单图、视频或录屏。</span>`;
    return;
  }

  els.mediaList.innerHTML = state.importedMedia
    .map((item) => {
      const kind = item.type.startsWith("video/") ? "视频" : "图片";
      const ocr = state.ocrResults.find((result) => result.signature === getMediaSignature(item));
      const ocrSnippet = ocr?.text ? ` · OCR：${ocr.text.slice(0, 24)}` : "";
      const ocrFailed = ocr?.error ? " · OCR 未识别" : "";
      return `<span class="media-pill">${kind} · ${escapeHtml(item.name)}${escapeHtml(ocrSnippet || ocrFailed)}</span>`;
    })
    .join("");
}

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractLoader) return tesseractLoader;

  tesseractLoader = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TESSERACT_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve(window.Tesseract);
    script.onerror = () => reject(new Error("ocr_script_failed"));
    document.head.appendChild(script);
  });

  return tesseractLoader;
}

async function runImageOcr() {
  const images = state.importedMedia.filter((item) => item.type.startsWith("image/") && item.file);
  if (!images.length) return [];

  const knownSignatures = new Set(images.map(getMediaSignature));
  state.ocrResults = state.ocrResults.filter((item) => knownSignatures.has(item.signature));
  const doneSignatures = new Set(state.ocrResults.map((item) => item.signature));
  const pendingImages = images.filter((item) => !doneSignatures.has(getMediaSignature(item)));
  if (!pendingImages.length) return state.ocrResults;

  state.ocrStatus = "running";
  renderMediaList();

  try {
    const Tesseract = await loadTesseract();

    for (let index = 0; index < pendingImages.length; index += 1) {
      const image = pendingImages[index];
      const signature = getMediaSignature(image);
      updateResolverCard("ocr", `OCR ${index + 1}/${pendingImages.length}`, "ready");

      try {
        const result = await Tesseract.recognize(image.file, "chi_sim+eng", {
          langPath: "https://tessdata.projectnaptha.com/4.0.0",
          workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js",
          corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core-simd.wasm.js",
        });
        const text = (result.data?.text || "").replace(/\s+/g, " ").trim();
        state.ocrResults.push({ signature, name: image.name, text });
      } catch (error) {
        console.warn("图片 OCR 失败。", error);
        state.ocrResults.push({ signature, name: image.name, text: "", error: "ocr_failed" });
      }

      renderMediaList();
    }

    state.ocrStatus = state.ocrResults.some((item) => item.text) ? "done" : "failed";
  } catch (error) {
    console.warn("OCR 引擎加载失败。", error);
    state.ocrStatus = "failed";
  }

  renderMediaList();
  return state.ocrResults;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

async function imageFileToAiDataUrl(file) {
  if (!file) return "";

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, AI_IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return readFileAsDataUrl(file);
  }
}

async function getAiImageInputs() {
  const images = state.importedMedia.filter((item) => item.type.startsWith("image/") && item.file).slice(0, AI_IMAGE_LIMIT);
  const dataUrls = [];

  for (const image of images) {
    try {
      const dataUrl = await imageFileToAiDataUrl(image.file);
      if (dataUrl) dataUrls.push(dataUrl);
    } catch (error) {
      console.warn("图片压缩失败，已跳过。", error);
    }
  }

  return dataUrls;
}

async function inspectCurrentLink() {
  const url = extractFirstUrl(els.sourceInput.value);
  const localInspection = getLocalLinkInspection(url);

  if (!url) {
    state.linkInspection = localInspection;
    state.linkPreview = null;
    renderMediaList();
    return localInspection;
  }

  els.inspectLinkBtn.disabled = true;
  els.inspectLinkBtn.textContent = "检测中";

  try {
    const params = new URLSearchParams({ url });
    const [inspectionResponse, previewResponse] = await Promise.all([
      fetch(`${API_BASE}/api/link/inspect?${params.toString()}`),
      fetch(`${API_BASE}/api/link/preview?${params.toString()}`),
    ]);
    const inspectionData = await inspectionResponse.json();
    const previewData = await previewResponse.json();
    state.linkInspection = inspectionData.ok ? inspectionData : localInspection;
    state.linkPreview = previewData.ok ? previewData : null;
  } catch {
    state.linkInspection = localInspection;
    state.linkPreview = null;
  } finally {
    els.inspectLinkBtn.disabled = false;
    els.inspectLinkBtn.textContent = "检测链接";
    renderMediaList();
  }

  return state.linkInspection;
}

function setApiStatus(kind, text) {
  state.apiProvider = kind;
  state.apiLive = kind === "live";
  els.apiStatus.className = `api-status ${kind}`;
  els.apiStatus.querySelector("span:last-child").textContent = text;
}

function setLanUrl(url) {
  state.lanUrl = url || "";
  if (!state.lanUrl) {
    els.copyLanUrlBtn.textContent = "未检测到";
    els.copyLanUrlBtn.title = "请确认电脑已连接 Wi-Fi，并从同一 Wi-Fi 下访问。";
    return;
  }

  els.copyLanUrlBtn.textContent = state.lanUrl.replace(/^https?:\/\//, "");
  els.copyLanUrlBtn.title = state.lanUrl;
}

async function checkApiStatus() {
  try {
    const response = await fetch(`${API_BASE}/api/status`);
    const data = await response.json();
    setLanUrl(data.lanUrls?.[0] || data.localUrl || "");
    state.aiProvider = data.aiProvider || (data.hasOpenAiKey ? "openai" : data.hasAmapKey ? "amap_extract" : "rules");
    if (data.hasOpenAiKey && data.hasAmapKey) {
      setApiStatus("live", "AI + 高德已连接");
      return;
    }
    if (data.hasOpenAiKey) {
      setApiStatus("live", "AI 识别已连接");
      return;
    }
    if (data.hasAmapKey) {
      setApiStatus("live", "高德识别已连接");
      return;
    }
    setApiStatus("mock", "模拟 POI");
  } catch {
    setApiStatus("offline", "本地 API 未启动");
    setLanUrl("");
  }
}

function projectLngLatToMap(lng, lat) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return {};
  const x = Math.min(86, Math.max(12, ((lng - 121.35) / 0.25) * 74 + 12));
  const y = Math.min(84, Math.max(12, 84 - ((lat - 31.16) / 0.14) * 72));
  return { x: Math.round(x), y: Math.round(y) };
}

function haversineDistance(lng1, lat1, lng2, lat2) {
  if (!Number.isFinite(lng1) || !Number.isFinite(lat1) || !Number.isFinite(lng2) || !Number.isFinite(lat2)) return null;
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateDistanceFromCoords(origin, dest) {
  const straightDist = haversineDistance(origin.lng, origin.lat, dest.lng, dest.lat);
  if (straightDist === null) return null;
  const walkDist = Math.round(straightDist * 1.45);
  const walkMin = Math.max(4, Math.round(walkDist / 80));
  const driveMin = Math.max(4, Math.round((straightDist * 1.55) / 500 + 2));
  return { walk: walkMin, drive: driveMin, straightDistM: Math.round(straightDist) };
}

const routeCache = {};

function getRouteCacheKey(originLng, originLat, destLng, destLat, type) {
  return `${originLng.toFixed(5)},${originLat.toFixed(5)}|${destLng.toFixed(5)},${destLat.toFixed(5)}|${type}`;
}

async function fetchRouteFromApi(originLng, originLat, destLng, destLat, type = "walking") {
  const key = getRouteCacheKey(originLng, originLat, destLng, destLat, type);
  if (routeCache[key]) return routeCache[key];

  try {
    const params = new URLSearchParams({
      origin: `${originLng},${originLat}`,
      destination: `${destLng},${destLat}`,
      type,
    });
    const response = await fetch(`${API_BASE}/api/amap/route?${params.toString()}`);
    const data = await response.json();
    if (data.live && data.route) {
      const route = {
        walkMin: Math.round(data.route.duration / 60),
        walkDistM: data.route.distance,
        walkSteps: data.route.steps,
        provider: "amap",
      };
      routeCache[key] = route;
      return route;
    }
    routeCache[key] = null;
    return null;
  } catch (error) {
    console.warn("路线 API 请求失败。", error);
    routeCache[key] = null;
    return null;
  }
}

state.routeResults = {};

function normalizeLiveEntity(entity, fallbackName, fallbackKind, city) {
  const projection = projectLngLatToMap(entity.lng, entity.lat);
  return {
    ...entity,
    id: entity.id || `${entity.kind || fallbackKind}-${normalizeId(entity.name || fallbackName)}`,
    name: entity.name || fallbackName,
    city: entity.city || city,
    kind: entity.kind || fallbackKind,
    confidence: entity.confidence || 0.88,
    source: entity.source || "高德 POI",
    notes: entity.notes?.length ? entity.notes : ["来自高德 POI，出发前建议再次确认"],
    ...projection,
  };
}

async function fetchLiveEntity(name, requestedKind, city) {
  try {
    const params = new URLSearchParams({ keywords: name, kind: requestedKind, city });
    const response = await fetch(`${API_BASE}/api/amap/search?${params.toString()}`);
    const data = await response.json();

    if (data.provider === "amap" && data.live && data.entity) {
      setApiStatus("live", "高德已连接");
      return normalizeLiveEntity(data.entity, name, requestedKind, city);
    }

    if (data.reason === "missing_amap_key") {
      setApiStatus("mock", "模拟 POI");
    }
  } catch {
    setApiStatus("offline", "本地 API 未启动");
  }

  return null;
}

function makeEntity(name, requestedKind = "dish", city = "上海") {
  const poi = poiKnowledgeBase[name];
  if (poi) {
    return {
      id: `${poi.kind}-${normalizeId(name)}`,
      name,
      city,
      kind: poi.kind,
      category: poi.category,
      area: poi.area,
      address: poi.address,
      opening: poi.opening,
      notes: poi.notes,
      confidence: poi.confidence,
      source: poi.source,
      lng: poi.lng,
      lat: poi.lat,
      x: poi.x,
      y: poi.y,
    };
  }

  const dish = dishKnowledgeBase[name];
  if (dish) {
    return {
      id: `dish-${normalizeId(name)}`,
      name,
      city,
      kind: "dish",
      category: dish.category,
      area: "按附近店铺匹配",
      address: "需要地图 API 推荐具体门店",
      opening: "跟随匹配门店",
      notes: dish.notes,
      confidence: 0.76,
      source: "偏好识别",
    };
  }

  return {
    id: `${requestedKind}-${normalizeId(name) || Date.now()}`,
    name,
    city,
    kind: requestedKind,
    category: requestedKind === "attraction" ? "景点" : requestedKind === "restaurant" ? "餐厅" : "美食偏好",
    area: "待定位",
    address: "待地图 API 补全",
    opening: "待地图 API 补全",
    notes: ["需要进一步确认地址和营业时间"],
    confidence: 0.54,
    source: "文本识别",
  };
}

async function makeEnrichedEntity(name, requestedKind = "dish", city = "上海") {
  const liveEntity = await fetchLiveEntity(name, requestedKind, city);
  return liveEntity || makeEntity(name, requestedKind, city);
}

function hydrateEntry(entry) {
  if (entry.entities?.length) return entry;
  const city = entry.city || document.querySelector("#citySelect").value;
  const attractionEntities = (entry.attractions || []).map((name) => makeEntity(name, "attraction", city));
  const foodEntities = (entry.foods || []).map((name) => {
    const known = poiKnowledgeBase[name];
    return makeEntity(name, known?.kind || "dish", city);
  });
  return { ...entry, entities: [...attractionEntities, ...foodEntities] };
}

function hasExtractedContent(entry) {
  return Boolean(entry.attractions?.length || entry.foods?.length);
}

function getStoredEntities() {
  const byKey = new Map();
  state.library.map(hydrateEntry).forEach((entry) => {
    entry.entities.forEach((entity) => {
      const key = `${entity.kind}:${entity.name}`;
      const existing = byKey.get(key);
      if (!existing || entity.confidence > existing.confidence) {
        byKey.set(key, { ...entity, sourceTitle: entry.title });
      }
    });
  });
  return [...byKey.values()].sort((a, b) => {
    const order = { attraction: 0, restaurant: 1, dish: 2 };
    return (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || b.confidence - a.confidence;
  });
}

function cleanCandidateName(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[【】《》「」『』#@]/g, " ")
    .replace(/^[\s，。；、,.!！?？:：-]+/, "")
    .replace(/^(今天|明天|昨天|周末|上午|中午|下午|晚上|早上|凌晨|先|再|然后|最后|顺路|附近|推荐|打卡|去|逛|玩|吃|喝|试试|想吃|想去|来到|到了|在|从|到|一家|这家|那家|一个|小红书|抖音|视频|截图)+/i, "")
    .replace(/(真的|特别|非常|很好吃|好吃|不错|排队|必吃|推荐|打卡|附近|路线|攻略|分享|收藏|避雷|人均|左右)$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
}

function dedupeNames(items) {
  const seen = new Set();
  const cleaned = [];

  items.forEach((item) => {
    const normalized = cleanCandidateName(item);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    cleaned.push(normalized);
  });

  return cleaned.slice(0, 24);
}

function isWeakCandidate(name) {
  return !name || name.length < 2 || ["美食", "景点", "餐厅", "攻略", "链接", "地址", "营业时间", "收藏", "位置"].includes(name);
}

function collectPatternMatches(text, pattern) {
  const matches = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const candidate = match[1] || match[0];
    const parts = String(candidate)
      .split(/[和与及、,，/]+/)
      .filter(Boolean);
    if (parts.length > 1) {
      parts.forEach((item) => matches.push(item));
    } else {
      matches.push(candidate);
    }
  }
  return matches;
}

function extractAttractionNames(text) {
  const knownAttractions = Object.entries(poiKnowledgeBase)
    .filter(([, item]) => item.kind === "attraction")
    .map(([name]) => name);
  const patternMatches = collectPatternMatches(
    text,
    /([\u4e00-\u9fa5A-Za-z0-9·&' -]{2,28}(?:博物馆|美术馆|纪念馆|公园|景区|古镇|古城|寺|塔|山|湖|海滩|外滩|园区|乐园|迪士尼|广场|商圈|步行街|老街|夜市|路|街|巷|弄|村|岛|湾|展览))/g,
  );
  const knownMatches = knownAttractions.filter((item) => text.includes(item));

  return dedupeNames([...knownMatches, ...patternMatches]).filter((item) => !isWeakCandidate(item));
}

function extractFoodNames(text) {
  const knownFoods = [
    ...Object.keys(dishKnowledgeBase),
    ...Object.entries(poiKnowledgeBase)
      .filter(([, item]) => item.kind === "restaurant")
      .map(([name]) => name),
    ...foodDatabase.flatMap((item) => [item.name, item.category, ...(item.match || [])]),
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
  ];
  const restaurantMatches = collectPatternMatches(
    text,
    /([\u4e00-\u9fa5A-Za-z0-9·&' -]{2,30}(?:餐厅|菜馆|饭店|酒楼|面馆|粉店|小笼|生煎|咖啡|Coffee|Cafe|cafe|火锅|烤肉|烧烤|小吃|甜品|茶餐厅|面包|酒馆|食堂|料理|寿司|拉面|串串|牛肉|羊肉|鸡煲|酸菜鱼|烤鱼|店))/gi,
  );
  const knownMatches = knownFoods.filter((item) => text.toLowerCase().includes(item.toLowerCase()));

  return dedupeNames([...knownMatches, ...restaurantMatches]).filter((item) => !isWeakCandidate(item));
}

function inferFoodEntityKind(name) {
  if (poiKnowledgeBase[name]?.kind === "restaurant") return "restaurant";
  if (/(餐厅|菜馆|饭店|酒楼|面馆|粉店|咖啡|Coffee|Cafe|cafe|火锅|烤肉|烧烤|小吃|甜品|茶餐厅|面包|酒馆|食堂|料理|寿司|拉面|串串|店)$/i.test(name)) {
    return "restaurant";
  }
  return "dish";
}

function hasAiExtractedContent(result) {
  return Boolean(result?.attractions?.length || result?.foods?.length);
}

function normalizeAiCandidateName(value) {
  return cleanCandidateName(value).replace(/^(店名|景点|美食|餐厅)[:：]/, "").trim();
}

function buildAiTextPayload(source, combinedSource) {
  return {
    source,
    linkText: "",
    ocrText: state.ocrResults.map((item) => item.text).filter(Boolean).join("\n"),
    mediaText: getMediaSignalText(),
    combinedSource,
  };
}

async function fetchAiExtraction({ source, combinedSource, city }) {
  try {
    const images = await getAiImageInputs();
    const textPayload = buildAiTextPayload(source, combinedSource);
    const response = await fetch(`${API_BASE}/api/ai/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        city,
        source: textPayload.source,
        linkText: textPayload.linkText,
        ocrText: textPayload.ocrText,
        mediaText: textPayload.mediaText,
        images,
      }),
    });
    const data = await response.json();
    if (data.provider === "openai" && data.live && data.result) {
      return data.result;
    }
    return null;
  } catch (error) {
    console.warn("AI 识别失败，已回退到规则识别。", error);
    return null;
  }
}

async function fetchPoiExtraction({ source, combinedSource, city }) {
  try {
    const textPayload = buildAiTextPayload(source, combinedSource);
    const response = await fetch(`${API_BASE}/api/poi/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        city,
        source: textPayload.source,
        ocrText: textPayload.ocrText,
        mediaText: textPayload.mediaText,
      }),
    });
    const data = await response.json();
    if ((data.provider === "amap_extract" || data.provider === "rules") && data.result) {
      return data.result;
    }
    return null;
  } catch (error) {
    console.warn("高德识别失败，已回退到本地规则。", error);
    return null;
  }
}

function getRuleExtraction(combinedSource) {
  return {
    attractions: extractAttractionNames(combinedSource),
    foods: extractFoodNames(combinedSource).map((name) => ({ name, kind: inferFoodEntityKind(name), reason: "", confidence: 0.7 })),
    notes: [],
    title: getSourceTitle(combinedSource),
    summary: "",
    confidence: 0.62,
    missingReason: "",
  };
}

async function buildExtraction(source) {
  await runImageOcr();
  const mediaSignal = getMediaSignalText();
  const combinedSource = [source, mediaSignal].filter(Boolean).join(" ");
  const city = document.querySelector("#citySelect").value;
  const aiExtraction = state.aiProvider === "openai" ? await fetchAiExtraction({ source, combinedSource, city }) : null;
  const poiExtraction = hasAiExtractedContent(aiExtraction) ? null : await fetchPoiExtraction({ source, combinedSource, city });
  const extraction = hasAiExtractedContent(aiExtraction)
    ? aiExtraction
    : hasAiExtractedContent(poiExtraction)
      ? poiExtraction
      : getRuleExtraction(combinedSource);
  const attractions = dedupeNames((extraction.attractions || []).map((item) => normalizeAiCandidateName(item.name || item)));
  const foodItems = extraction.foods || [];
  const foods = dedupeNames(foodItems.map((item) => normalizeAiCandidateName(item.name || item)));
  const foodKindByName = new Map(
    foodItems
      .map((item) => [normalizeAiCandidateName(item.name || item), item.kind === "restaurant" ? "restaurant" : inferFoodEntityKind(item.name || item)])
      .filter(([name]) => name),
  );
  const images = state.importedMedia.filter((item) => item.type.startsWith("image/"));
  const videos = state.importedMedia.filter((item) => item.type.startsWith("video/"));
  const notes = [
    aiExtraction ? "已使用 AI 识别文案和截图内容" : poiExtraction ? "已使用高德 POI 校验文案和截图识别结果" : "已使用本地规则识别文案和截图",
    state.ocrResults.some((item) => item.text) ? "已读取截图 OCR 文字参与识别" : images.length ? "截图 OCR 未读到有效文字，可换更清晰截图" : "未上传图片，可粘贴文案或上传截图补充",
    combinedSource.includes("晚上") ? "晚上行程适合加入夜景或晚餐安排" : "按用餐时间匹配附近店铺",
    foods.includes("蟹黄面") ? "蟹黄面价格可能偏高，适合作为重点餐" : "热门店建议错峰",
    ...(extraction.notes || []),
    extraction.missingReason && !hasAiExtractedContent(extraction) ? extraction.missingReason : "",
    videos.length ? `已加入 ${videos.length} 个视频关键帧/语音通道` : "未上传视频，视频内容需要授权抓取或上传补充",
    "营业时间和闭店状态出发前再确认",
  ].filter(Boolean);
  const entities = await Promise.all([
    ...attractions.map((name) => makeEnrichedEntity(name, "attraction", city)),
    ...foods.map((name) => makeEnrichedEntity(name, foodKindByName.get(name) || inferFoodEntityKind(name), city)),
  ]);

  return {
    id: `entry-${Date.now()}`,
    title: extraction.title || getSourceTitle(combinedSource),
    source: source || mediaSignal || "截图识别",
    sourceUrl: extractFirstUrl(source),
    createdAt: new Date().toISOString(),
    city,
    attractions,
    foods,
    notes,
    media: state.importedMedia.map((item) => ({
      name: item.name,
      type: item.type,
      size: item.size,
      channel: item.type.startsWith("video/") ? "video_frame_asr" : "image_ocr",
    })),
    linkInspection: state.linkInspection || getLocalLinkInspection(extractFirstUrl(source)),
    entities,
  };
}

function upsertAttraction(name) {
  const existing = state.attractions.find((item) => item.name === name);
  if (existing) return existing.id;

  const offset = state.attractions.length * 7;
  const poi = poiKnowledgeBase[name];
  const id = normalizeId(name) || `place-${Date.now()}`;
  state.attractions.push({
    id,
    name,
    area: poi?.area || "待定位",
    address: poi?.address || "待地图 API 补全",
    lng: poi?.lng,
    lat: poi?.lat,
    x: poi?.x || 28 + (offset % 48),
    y: poi?.y || 28 + ((offset * 2) % 42),
  });
  return id;
}

function upsertFood(name) {
  if (!state.foods.includes(name)) state.foods.push(name);
}

function getActiveAttraction() {
  return state.attractions.find((item) => item.id === state.activeAttractionId) || state.attractions[0];
}

function getFoodMatches(food) {
  const keywords = [food.name, food.category, ...(food.match || [])].filter(Boolean);
  return keywords.some((keyword) => state.foods.some((wanted) => wanted.includes(keyword) || keyword.includes(wanted)));
}

function inferMeals(entity) {
  const text = `${entity.name} ${entity.category}`;
  if (text.includes("咖啡") || text.includes("早午餐")) return ["breakfast", "tea"];
  if (text.includes("小笼") || text.includes("生煎")) return ["breakfast", "lunch"];
  if (text.includes("面")) return ["lunch", "dinner"];
  return ["lunch", "dinner"];
}

function estimateDistance(active, entity) {
  if (entity.lng != null && entity.lat != null && active.lng != null && active.lat != null) {
    const estimate = estimateDistanceFromCoords(active, entity);
    if (estimate) {
      return {
        walk: estimate.walk,
        drive: estimate.drive,
        x: entity.x || Math.min(76, active.x + 10),
        y: entity.y || Math.min(76, active.y + 10),
        fromCoords: true,
      };
    }
  }

  if (!entity.x || !entity.y) {
    return { walk: 99, drive: 35, x: Math.min(76, active.x + 10), y: Math.min(76, active.y + 10) };
  }
  const distance = Math.hypot(entity.x - active.x, entity.y - active.y);
  const walk = Math.max(4, Math.round(distance * 0.75));
  return {
    walk,
    drive: Math.max(4, Math.round(walk * 0.45 + 2)),
    x: entity.x,
    y: entity.y,
  };
}

function getLibraryRestaurantOptions(active, knownNames) {
  return getStoredEntities()
    .filter((entity) => entity.kind === "restaurant")
    .filter((entity) => !knownNames.has(entity.name))
    .map((entity) => {
      const meals = inferMeals(entity);
      const distance = estimateDistance(active, entity);
      const option = {
        id: `library-${entity.id}`,
        name: entity.name,
        match: [entity.category, entity.name],
        category: entity.category,
        area: entity.area,
        address: entity.address,
        opening: entity.opening,
        meals,
        open: entity.opening !== "待地图 API 补全",
        price: "待补充",
        lng: entity.lng,
        lat: entity.lat,
        note: entity.notes?.join("；") || "来自识别资料库，建议出发前确认。",
        reason: `来自你的识别资料库，已补全到${entity.area}，可以参与附近推荐。`,
        distances: { [active.id]: distance },
      };
      return option;
    });
}

function getRecommendations() {
  const active = getActiveAttraction();
  const activeId = active.id;
  const knownNames = new Set(foodDatabase.map((food) => food.name));
  return [...foodDatabase, ...getLibraryRestaurantOptions(active, knownNames)]
    .filter((food) => food.distances[activeId])
    .filter((food) => food.meals.includes(state.activeMeal))
    .filter((food) => (state.openOnly ? food.open : true))
    .map((food) => {
      const distance = food.distances[activeId];
      const wishScore = getFoodMatches(food) ? 42 : 18;
      const walkScore = Math.max(0, 35 - distance.walk);
      const openScore = food.open ? 14 : 0;
      const mealScore = food.meals.includes(state.activeMeal) ? 9 : 0;
      const score = Math.min(98, wishScore + walkScore + openScore + mealScore);
      return { ...food, distance, score };
    })
    .filter((food) => food.distance.walk <= state.walkLimit || food.distance.drive <= 20)
    .sort((a, b) => b.score - a.score);
}

function renderAttractions() {
  els.attractionList.innerHTML = "";
  state.attractions.forEach((item) => {
    const row = document.createElement("div");
    row.className = `place-item ${item.id === state.activeAttractionId ? "active" : ""}`;

    const content = document.createElement("button");
    content.type = "button";
    content.className = "place-item";
    content.innerHTML = `
      <div>
        <div class="place-name">${escapeHtml(item.name)}</div>
        <div class="place-meta">${escapeHtml(item.area)} · ${escapeHtml(item.address)}</div>
      </div>
      <span class="status-pill">选择</span>
    `;
    content.classList.toggle("active", item.id === state.activeAttractionId);
    content.addEventListener("click", () => {
      state.activeAttractionId = item.id;
      render();
    });

    row.replaceWith(content);
    els.attractionList.appendChild(content);
  });
}

function renderFoods() {
  els.foodList.innerHTML = "";
  state.foods.forEach((food) => {
    const chip = document.createElement("span");
    chip.className = "chip food";
    chip.innerHTML = `${escapeHtml(food)}<button type="button" aria-label="删除 ${escapeHtml(food)}">x</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      state.foods = state.foods.filter((item) => item !== food);
      render();
    });
    els.foodList.appendChild(chip);
  });
}

function renderLibrary() {
  els.libraryCount.textContent = `${state.library.length} 条`;
  els.libraryList.innerHTML = "";

  if (!state.library.length) {
    els.libraryList.innerHTML = `
      <div class="empty-state">
        还没有入库内容。识别一段探店文案、行程描述或截图后，景点和美食会保存在这里。
      </div>
    `;
    return;
  }

  state.library = state.library.map(hydrateEntry);
  state.library.forEach((entry) => {
    const mediaCount = entry.media?.length || 0;
    const entityPreview = entry.entities
      .slice(0, 3)
      .map((entity) => `${entity.name} · ${entity.opening}`)
      .join(" / ");
    const card = document.createElement("article");
    card.className = "library-card";
    card.innerHTML = `
      <div class="library-card-header">
        <h3 title="${escapeHtml(entry.title)}">${escapeHtml(entry.title)}</h3>
        <span class="library-time">${formatDateTime(entry.createdAt)}</span>
      </div>
      <p class="library-source">${escapeHtml(entry.source)}</p>
      <div class="library-tags">
        ${entry.attractions.map((item) => `<span class="library-tag place">景点 · ${escapeHtml(item)}</span>`).join("")}
        ${entry.foods.map((item) => `<span class="library-tag food">美食 · ${escapeHtml(item)}</span>`).join("")}
        ${mediaCount ? `<span class="library-tag">媒体 · ${mediaCount}</span>` : ""}
      </div>
      <p class="library-source">已补全：${escapeHtml(entityPreview || "等待地图 API 补全")}</p>
      <div class="library-card-actions">
        <button type="button" data-action="apply" data-id="${entry.id}">加入清单</button>
        <button type="button" data-action="view" data-id="${entry.id}">查看详情</button>
        <button class="delete-entry" type="button" data-action="delete" data-id="${entry.id}" aria-label="删除 ${escapeHtml(entry.title)}">x</button>
      </div>
    `;
    els.libraryList.appendChild(card);
  });
}

function renderEntityDatabase() {
  const entities = getStoredEntities();
  const attractionCount = entities.filter((item) => item.kind === "attraction").length;
  const restaurantCount = entities.filter((item) => item.kind === "restaurant").length;
  const dishCount = entities.filter((item) => item.kind === "dish").length;

  els.entitySummary.innerHTML = `
    <div class="summary-tile"><strong>${attractionCount}</strong><span>景点</span></div>
    <div class="summary-tile"><strong>${restaurantCount}</strong><span>餐厅</span></div>
    <div class="summary-tile"><strong>${dishCount}</strong><span>美食</span></div>
  `;

  if (!entities.length) {
    els.entityList.innerHTML = `
      <div class="empty-state">
        地点详情会在识别入库后出现，包括地址、营业时间、注意事项和可信度。
      </div>
    `;
    return;
  }

  els.entityList.innerHTML = entities
    .map((entity) => {
      const kindLabel = entity.kind === "attraction" ? "景点" : entity.kind === "restaurant" ? "餐厅" : "美食";
      return `
        <article class="entity-row">
          <div>
            <h4>${escapeHtml(entity.name)}</h4>
            <p>${escapeHtml(entity.category)} · ${escapeHtml(entity.area)} · ${escapeHtml(entity.address)}</p>
            <p>营业时间：${escapeHtml(entity.opening)}</p>
            <div class="entity-meta">
              <span class="entity-kind ${entity.kind}">${kindLabel}</span>
              <span class="library-tag">${escapeHtml(entity.source)}</span>
              <span class="library-tag">${escapeHtml(entity.notes?.[0] || "待补充注意事项")}</span>
            </div>
          </div>
          <span class="confidence-pill">${Math.round(entity.confidence * 100)}%</span>
        </article>
      `;
    })
    .join("");
}

function renderSelectedPlace() {
  const active = getActiveAttraction();
  els.selectedPlace.innerHTML = `
    <h3>${escapeHtml(active.name)}</h3>
    <p>${escapeHtml(active.address)}</p>
    <p>正在按“${mealLabels[state.activeMeal]}”、步行 ${state.walkLimit} 分钟内优先，为你找愿望清单里的附近美食。</p>
  `;
}

function renderRecommendations() {
  const recs = getRecommendations();
  els.recommendList.innerHTML = "";

  if (!recs.length) {
    els.recommendList.innerHTML = `
      <div class="empty-state">
        当前筛选下没有足够近的匹配。可以放宽步行时间，或切换用餐时段看看。
      </div>
    `;
    return;
  }

  recs.forEach((food, index) => {
    const active = getActiveAttraction();
    const routeId = `${active.id}:${food.id}`;
    const realRoute = state.routeResults[routeId];
    const walkMin = realRoute?.walk?.min ?? food.distance.walk;
    const driveMin = realRoute?.drive?.min ?? food.distance.drive;
    const walkLabel = realRoute?.walk ? "步行" : "约步行";
    const driveLabel = realRoute?.drive ? "驾车" : "约打车";
    const isReal = Boolean(realRoute?.walk || realRoute?.drive);

    const card = document.createElement("article");
    card.className = `recommend-card ${index === 0 ? "best" : ""}`;
    card.innerHTML = `
      <div class="rec-top">
        <div>
          <h3>${escapeHtml(food.name)}</h3>
          <p class="muted">${escapeHtml(food.category)} · ${escapeHtml(food.address)}</p>
        </div>
        <span class="score">${food.score}</span>
      </div>
      <div class="rec-meta">
        <span class="meta-pill ${isReal ? "live-route" : ""}">${walkLabel} ${walkMin} 分钟${isReal ? " ✓" : ""}</span>
        <span class="meta-pill ${realRoute?.drive ? "live-route" : ""}">${driveLabel} ${driveMin} 分钟</span>
        <span class="meta-pill ${food.open ? "open" : "closed"}">${food.open ? "当前营业" : "待确认"}</span>
        <span class="meta-pill">${escapeHtml(food.opening)}</span>
        <span class="meta-pill">${escapeHtml(food.price)}</span>
      </div>
      <p class="rec-reason">${escapeHtml(food.reason)}</p>
      <p class="rec-notes">注意事项：${escapeHtml(food.note)}</p>
    `;
    els.recommendList.appendChild(card);
  });
}

function renderMap() {
  const active = getActiveAttraction();
  const recs = getRecommendations().slice(0, 3);
  const primary = recs[0];
  const activeFoodPoint = primary ? primary.distance : { x: 60, y: 45 };

  els.mapCanvas.innerHTML = `
    <div class="map-road"></div>
    <div class="map-road secondary"></div>
    <div class="route-line" style="left:${Math.min(active.x, activeFoodPoint.x)}%; top:${(active.y + activeFoodPoint.y) / 2}%; width:${Math.abs(activeFoodPoint.x - active.x) + 16}%;"></div>
    <div class="map-pin" style="left:${active.x}%; top:${active.y}%"><span>景</span></div>
    <div class="map-label" style="left:${Math.min(78, active.x + 4)}%; top:${Math.max(6, active.y - 12)}%">${escapeHtml(active.name)}</div>
    ${recs
      .map((food, index) => {
        const routeId = `${active.id}:${food.id}`;
        const realRoute = state.routeResults[routeId];
        const walkMin = realRoute?.walk?.min ?? food.distance.walk;
        const x = food.distance.x;
        const y = food.distance.y;
        return `
          <div class="map-pin food-pin" style="left:${x}%; top:${y}%"><span>${index + 1}</span></div>
          <div class="map-label" style="left:${Math.min(78, x + 3)}%; top:${Math.min(82, y + 4)}%">${escapeHtml(food.name)}<br>${walkMin} 分钟${realRoute?.walk ? ' ✓' : ' 约'}</div>
        `;
      })
      .join("")}
  `;
}

function renderItinerary(generated = false) {
  const active = getActiveAttraction();
  const recs = getRecommendations();

  const getRouteWalkMin = (food) => {
    if (!food) return 0;
    const routeId = `${active.id}:${food.id}`;
    const realRoute = state.routeResults[routeId];
    return realRoute?.walk?.min ?? food.distance.walk;
  };

  const getRouteDriveMin = (food) => {
    if (!food) return 0;
    const routeId = `${active.id}:${food.id}`;
    const realRoute = state.routeResults[routeId];
    return realRoute?.drive?.min ?? food.distance.drive;
  };

  if (!generated) {
    const top = recs[0];
    const walkMin = getRouteWalkMin(top);
    els.itinerary.innerHTML = top
      ? `
        <div class="timeline-row">
          <span class="time-badge">${mealLabels[state.activeMeal]}</span>
          <div class="timeline-copy">
            <strong>${escapeHtml(active.name)} -> ${escapeHtml(top.name)}</strong>
            <span>${walkMin} 分钟步行，${escapeHtml(top.category)}，${escapeHtml(top.opening)}</span>
          </div>
        </div>
      `
      : `<p class="muted">暂无可用路线，放宽筛选后再试。</p>`;
    return;
  }

  const top = recs[0];
  const second = recs[1];
  const topWalk = getRouteWalkMin(top);
  const secondDrive = getRouteDriveMin(second);
  els.itinerary.innerHTML = `
    <div class="timeline-row">
      <span class="time-badge">10:00</span>
      <div class="timeline-copy">
        <strong>${escapeHtml(active.name)}</strong>
        <span>${escapeHtml(active.area)} 开始游览，预留 1.5 到 2 小时。</span>
      </div>
    </div>
    <div class="timeline-row">
      <span class="time-badge">${state.activeMeal === "dinner" ? "18:00" : "12:00"}</span>
      <div class="timeline-copy">
        <strong>${top ? escapeHtml(top.name) : "附近备选餐厅"}</strong>
        <span>${top ? `${topWalk} 分钟步行，${escapeHtml(top.note)}` : "建议换一个用餐时段继续筛选。"}</span>
      </div>
    </div>
    <div class="timeline-row">
      <span class="time-badge">15:30</span>
      <div class="timeline-copy">
        <strong>${second ? `备选：${escapeHtml(second.name)}` : "留出机动时间"}</strong>
        <span>${second ? `${escapeHtml(second.category)}，打车约 ${secondDrive} 分钟。` : "适合加咖啡、拍照点或返回酒店休息。"}</span>
      </div>
    </div>
  `;
}

function renderExtractionResult(entry, saved = false) {
  const hydrated = hydrateEntry(entry);
  const attractionHtml = hydrated.attractions.length
    ? hydrated.attractions.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")
    : `<span class="muted">暂未识别到景点，可以手动添加。</span>`;
  const foodHtml = hydrated.foods.length
    ? hydrated.foods.map((item) => `<span class="chip food">${escapeHtml(item)}</span>`).join("")
    : `<span class="muted">暂未识别到美食，可以手动添加。</span>`;
  const detailHtml = hydrated.entities
    .map(
      (entity) => `
        <p class="muted">${escapeHtml(entity.name)}：${escapeHtml(entity.address)} · ${escapeHtml(entity.opening)} · ${Math.round(entity.confidence * 100)}%</p>
      `,
    )
    .join("");
  const mediaHtml = hydrated.media?.length
    ? hydrated.media.map((item) => `<span class="chip">${escapeHtml(item.channel === "video_frame_asr" ? "视频" : "图片")} · ${escapeHtml(item.name)}</span>`).join("")
    : `<span class="muted">未附加媒体文件。</span>`;
  const inspectionLabel = getInspectionLabel(hydrated.linkInspection);

  els.extractionBox.innerHTML = `
    <div class="extracted-group">
      <p class="extracted-title">识别到的景点</p>
      <div class="tag-row">${attractionHtml}</div>
    </div>
    <div class="extracted-group">
      <p class="extracted-title">识别到的店/菜</p>
      <div class="tag-row">${foodHtml}</div>
    </div>
    <div class="extracted-group">
      <p class="extracted-title">攻略注意事项</p>
      <p class="muted">${hydrated.notes.map(escapeHtml).join("；")}。</p>
    </div>
    <div class="extracted-group">
      <p class="extracted-title">识别通道</p>
      <p class="muted">文案/截图识别；${escapeHtml(inspectionLabel === "待检测" ? "未使用链接解析" : inspectionLabel)}</p>
      <div class="tag-row">${mediaHtml}</div>
    </div>
    <div class="extracted-group">
      <p class="extracted-title">地点补全结果</p>
      ${detailHtml || `<p class="muted">暂无地点详情，等待地图 API 补全。</p>`}
    </div>
    <div class="extracted-group">
      <p class="extracted-title">${saved ? "已保存到资料库" : "资料库详情"}</p>
      <p class="muted">${escapeHtml(hydrated.city)} · ${formatDateTime(hydrated.createdAt)} · ${escapeHtml(hydrated.sourceUrl || "手动输入")}</p>
    </div>
  `;
}

function renderEmptyExtractionResult(entry) {
  state.pendingEntry = null;
  const inspectionLabel = getInspectionLabel(entry.linkInspection);
  const mediaCount = entry.media?.length || 0;

  els.extractionBox.innerHTML = `
    <div class="extracted-group">
      <p class="extracted-title">未入库</p>
      <p class="muted">这次没有识别到景点、店名或美食偏好，所以没有保存到资料库。</p>
    </div>
    <div class="extracted-group">
      <p class="extracted-title">识别通道</p>
      <p class="muted">文案/截图识别；媒体文件：${mediaCount} 个。</p>
    </div>
    <div class="extracted-group">
      <p class="extracted-title">下一步建议</p>
      <p class="muted">可以补充粘贴文案、上传视频截图，或手动输入看到的店名/景点名后再识别。</p>
    </div>
  `;
}

function renderReviewChips(items, type) {
  if (!items.length) return `<span class="muted">暂无，可手动添加。</span>`;
  return items
    .map(
      (item) => `
        <span class="chip ${type === "food" ? "food" : ""}">
          ${escapeHtml(item)}
          <button type="button" data-review-action="remove" data-type="${type}" data-name="${escapeHtml(item)}" aria-label="移除 ${escapeHtml(item)}">x</button>
        </span>
      `,
    )
    .join("");
}

function renderExtractionReview(entry) {
  state.pendingEntry = hydrateEntry(entry);
  const hydrated = state.pendingEntry;
  const inspectionLabel = getInspectionLabel(hydrated.linkInspection);
  const mediaCount = hydrated.media?.length || 0;

  els.extractionBox.innerHTML = `
    <div class="extracted-group">
      <p class="extracted-title">确认后入库</p>
      <p class="muted">请先检查识别结果，删除不对的内容，也可以手动补充。确认后才会保存到资料库。</p>
    </div>

    <div class="review-section">
      <p class="extracted-title">识别到的景点</p>
      <div class="tag-row">${renderReviewChips(hydrated.attractions, "attraction")}</div>
      <div class="review-row">
        <input id="reviewAttractionInput" type="text" placeholder="补充景点，例如：豫园" />
        <button type="button" data-review-action="add" data-type="attraction" aria-label="补充景点">+</button>
      </div>
    </div>

    <div class="review-section">
      <p class="extracted-title">识别到的店/菜</p>
      <div class="tag-row">${renderReviewChips(hydrated.foods, "food")}</div>
      <div class="review-row">
        <input id="reviewFoodInput" type="text" placeholder="补充美食或店名，例如：生煎" />
        <button type="button" data-review-action="add" data-type="food" aria-label="补充美食">+</button>
      </div>
    </div>

    <div class="extracted-group">
      <p class="extracted-title">识别通道</p>
      <p class="muted">文案/截图识别；媒体文件：${mediaCount} 个。</p>
    </div>

    <div class="review-actions">
      <button class="review-save" type="button" data-review-action="save">确认入库</button>
      <button class="review-reset" type="button" data-review-action="discard">放弃本次识别</button>
    </div>
  `;
}

async function rebuildPendingEntities(entry) {
  const city = entry.city || document.querySelector("#citySelect").value;
  const entities = await Promise.all([
    ...(entry.attractions || []).map((name) => makeEnrichedEntity(name, "attraction", city)),
    ...(entry.foods || []).map((name) => makeEnrichedEntity(name, inferFoodEntityKind(name), city)),
  ]);
  return { ...entry, city, entities };
}

function saveExtractionToLibrary(entry) {
  const hydratedEntry = hydrateEntry(entry);
  if (!hasExtractedContent(hydratedEntry)) return null;

  const fingerprint = `${hydratedEntry.city}|${hydratedEntry.source.trim()}|${hydratedEntry.attractions.join(",")}|${hydratedEntry.foods.join(",")}`;
  const existing = state.library.find((item) => item.fingerprint === fingerprint);

  if (existing) {
    existing.createdAt = new Date().toISOString();
    existing.notes = hydratedEntry.notes;
    existing.entities = hydratedEntry.entities;
    state.library = [existing, ...state.library.filter((item) => item.id !== existing.id)];
    saveLibrary();
    syncLibraryToCloud("save");
    return existing;
  }

  const nextEntry = { ...hydratedEntry, fingerprint };
  state.library = [nextEntry, ...state.library].slice(0, 50);
  saveLibrary();
  syncLibraryToCloud("save");
  return nextEntry;
}

function applyLibraryEntry(entry) {
  const hydrated = hydrateEntry(entry);
  hydrated.attractions.forEach((name) => {
    state.activeAttractionId = upsertAttraction(name);
  });
  hydrated.foods.forEach(upsertFood);
  renderExtractionResult(hydrated);
  render();
}

async function refreshLibraryPoi() {
  if (!state.library.length) return;

  els.refreshPoiBtn.disabled = true;
  els.refreshPoiBtn.textContent = "补全中";

  try {
    const refreshed = [];
    for (const entry of state.library.map(hydrateEntry)) {
      const city = entry.city || document.querySelector("#citySelect").value;
      const entities = await Promise.all([
        ...(entry.attractions || []).map((name) => makeEnrichedEntity(name, "attraction", city)),
        ...(entry.foods || []).map((name) => {
          const existing = entry.entities.find((entity) => entity.name === name);
          return makeEnrichedEntity(name, existing?.kind || poiKnowledgeBase[name]?.kind || "dish", city);
        }),
      ]);
      refreshed.push({ ...entry, entities });
    }

    state.library = refreshed;
    saveLibrary();
    syncLibraryToCloud("save");
    render();
  } finally {
    els.refreshPoiBtn.disabled = false;
    els.refreshPoiBtn.textContent = "重新补全";
  }
}

function updatePendingReview() {
  if (!state.pendingEntry) return;
  if (!hasExtractedContent(state.pendingEntry)) {
    renderEmptyExtractionResult(state.pendingEntry);
    return;
  }
  renderExtractionReview(state.pendingEntry);
}

function addPendingItem(type) {
  if (!state.pendingEntry) return;
  const input = type === "attraction" ? document.querySelector("#reviewAttractionInput") : document.querySelector("#reviewFoodInput");
  const name = input?.value.trim();
  if (!name) return;

  const key = type === "attraction" ? "attractions" : "foods";
  if (!state.pendingEntry[key].includes(name)) state.pendingEntry[key].push(name);
  updatePendingReview();
}

function removePendingItem(type, name) {
  if (!state.pendingEntry) return;
  const key = type === "attraction" ? "attractions" : "foods";
  state.pendingEntry[key] = state.pendingEntry[key].filter((item) => item !== name);
  updatePendingReview();
}

async function savePendingEntry(button) {
  if (!state.pendingEntry) return;

  if (!hasExtractedContent(state.pendingEntry)) {
    renderEmptyExtractionResult(state.pendingEntry);
    return;
  }

  button.disabled = true;
  button.textContent = "保存中";

  try {
    const enriched = await rebuildPendingEntities(state.pendingEntry);
    const savedEntry = saveExtractionToLibrary(enriched);

    if (!savedEntry) {
      renderEmptyExtractionResult(enriched);
      return;
    }

    savedEntry.attractions.forEach((name) => {
      state.activeAttractionId = upsertAttraction(name);
    });
    savedEntry.foods.forEach(upsertFood);

    state.pendingEntry = null;
    renderExtractionResult(savedEntry, true);
    render();
  } finally {
    button.disabled = false;
    button.textContent = "确认入库";
  }
}

async function renderExtraction() {
  const source = els.sourceInput.value.trim();
  if (!source && !state.importedMedia.length) {
    els.extractionBox.innerHTML = `<p class="muted">先粘贴一段文案，或上传截图/视频，再识别入库。</p>`;
    return;
  }

  els.extractBtn.disabled = true;
  els.extractBtn.innerHTML = `<span class="btn-icon" aria-hidden="true">+</span>识别中`;

  try {
    const entry = await buildExtraction(source);

    if (!hasExtractedContent(entry)) {
      renderEmptyExtractionResult(entry);
      render();
      return;
    }

    renderExtractionReview(entry);
    render();
  } finally {
    els.extractBtn.disabled = false;
    els.extractBtn.innerHTML = `<span class="btn-icon" aria-hidden="true">+</span>识别预览`;
  }
}

function addAttraction() {
  const name = els.attractionInput.value.trim();
  if (!name) return;
  state.activeAttractionId = upsertAttraction(name);
  els.attractionInput.value = "";
  render();
}

function addFood() {
  const name = els.foodInput.value.trim();
  if (!name) return;
  upsertFood(name);
  els.foodInput.value = "";
  render();
}

async function refreshRealRoutes() {
  const active = getActiveAttraction();
  if (!active.lng || !active.lat) return;

  const recs = getRecommendations().slice(0, 3);
  const routePromises = recs.map(async (food) => {
    if (food.lng == null || food.lat == null) return;

    const routeId = `${active.id}:${food.id}`;
    if (state.routeResults[routeId] && state.routeResults[routeId].walk) return;

    const [walkRoute, driveRoute] = await Promise.all([
      fetchRouteFromApi(active.lng, active.lat, food.lng, food.lat, "walking"),
      fetchRouteFromApi(active.lng, active.lat, food.lng, food.lat, "driving"),
    ]);

    state.routeResults[routeId] = {
      walk: walkRoute ? { min: walkRoute.walkMin, distM: walkRoute.walkDistM, steps: walkRoute.walkSteps } : null,
      drive: driveRoute ? { min: Math.round(driveRoute.walkDistM / 500 + 2), distM: driveRoute.walkDistM } : null,
      provider: walkRoute?.provider || driveRoute?.provider || null,
    };

    renderRecommendations();
    renderMap();
  });

  await Promise.allSettled(routePromises);
}

function render(generated = false) {
  state.walkLimit = Number(els.walkLimit.value);
  state.openOnly = els.openOnly.checked;
  renderAttractions();
  renderFoods();
  renderLibrary();
  renderEntityDatabase();
  renderMediaList();
  renderSelectedPlace();
  renderRecommendations();
  renderMap();
  renderItinerary(generated);

  refreshRealRoutes();
}

els.extractBtn.addEventListener("click", () => {
  renderExtraction();
});
els.clearBtn.addEventListener("click", () => {
  els.sourceInput.value = "";
  state.linkInspection = null;
  state.linkPreview = null;
  state.pendingEntry = null;
  state.ocrResults = [];
  state.ocrStatus = "idle";
  state.importedMedia = [];
  els.mediaInput.value = "";
  els.extractionBox.innerHTML = `<p class="muted">点击识别后，这里会预览从文案和截图中抽取出的店名、景点和菜品，确认后再保存到资料库。</p>`;
  renderMediaList();
});

els.sourceInput.addEventListener("input", () => {
  state.linkInspection = null;
  state.linkPreview = null;
  state.pendingEntry = null;
  els.extractionBox.innerHTML = `<p class="muted">内容已变化，请重新识别预览。</p>`;
  renderMediaList();
});

els.inspectLinkBtn?.addEventListener("click", () => {
  inspectCurrentLink();
});

els.mediaInput.addEventListener("change", () => {
  state.importedMedia = [...els.mediaInput.files].map((file) => ({
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    file,
  }));
  state.ocrResults = [];
  state.ocrStatus = "idle";
  state.pendingEntry = null;
  els.extractionBox.innerHTML = `<p class="muted">媒体文件已变化，请重新识别预览。</p>`;
  renderMediaList();
});

els.extractionBox.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-review-action]");
  if (!button) return;

  const action = button.dataset.reviewAction;
  const type = button.dataset.type;

  if (action === "add") addPendingItem(type);
  if (action === "remove") removePendingItem(type, button.dataset.name);
  if (action === "save") savePendingEntry(button);
  if (action === "discard") {
    state.pendingEntry = null;
    els.extractionBox.innerHTML = `<p class="muted">已放弃本次识别，没有写入资料库。</p>`;
  }
});

els.extractionBox.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const input = event.target.closest("#reviewAttractionInput, #reviewFoodInput");
  if (!input) return;
  event.preventDefault();
  addPendingItem(input.id === "reviewAttractionInput" ? "attraction" : "food");
});

els.libraryList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const entry = state.library.find((item) => item.id === button.dataset.id);
  if (!entry) return;

  if (button.dataset.action === "apply") {
    applyLibraryEntry(entry);
  }

  if (button.dataset.action === "view") {
    els.sourceInput.value = entry.source;
    renderExtractionResult(entry);
  }

  if (button.dataset.action === "delete") {
    const shouldDelete = window.confirm("确定从本地资料库删除这条识别记录吗？");
    if (!shouldDelete) return;
    state.library = state.library.filter((item) => item.id !== entry.id);
    saveLibrary();
    syncLibraryToCloud("delete");
    render();
  }
});

els.copyCloudLinkBtn.addEventListener("click", async () => {
  const shareUrl = getCloudShareUrl();
  try {
    await navigator.clipboard.writeText(shareUrl);
    els.copyCloudLinkBtn.textContent = "已复制";
    window.setTimeout(() => {
      els.copyCloudLinkBtn.textContent = "复制同步链接";
    }, 1200);
  } catch {
    window.prompt("复制这个同步链接到其他设备：", shareUrl);
  }
});

els.exportLibraryBtn.addEventListener("click", async () => {
  const payload = JSON.stringify(
    {
      version: 1,
      app: "shunluchi",
      exportedAt: new Date().toISOString(),
      space: CLOUD_SPACE_ID,
      library: state.library.map(hydrateEntry),
    },
    null,
    2,
  );
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const fileName = `shunluchi-library-${stamp}.json`;

  try {
    const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);

    els.exportLibraryBtn.textContent = "已下载";
    window.setTimeout(() => {
      els.exportLibraryBtn.textContent = "导出 JSON";
    }, 1200);
  } catch {
    try {
      await navigator.clipboard.writeText(payload);
      els.exportLibraryBtn.textContent = "已复制";
    } catch {
      els.sourceInput.value = payload;
      els.exportLibraryBtn.textContent = "已放入输入框";
    }
    window.setTimeout(() => {
      els.exportLibraryBtn.textContent = "导出 JSON";
    }, 1200);
  }
});

els.clearLibraryBtn.addEventListener("click", () => {
  const shouldClear = window.confirm("确定清空资料库吗？这个操作会同步清空云端和当前浏览器缓存。");
  if (!shouldClear) return;
  state.library = [];
  saveLibrary();
  syncLibraryToCloud("clear");
  render();
});

els.refreshPoiBtn.addEventListener("click", () => {
  refreshLibraryPoi();
});

els.copyLanUrlBtn.addEventListener("click", async () => {
  if (!state.lanUrl) return;
  try {
    await navigator.clipboard.writeText(state.lanUrl);
    els.copyLanUrlBtn.textContent = "已复制";
    window.setTimeout(() => setLanUrl(state.lanUrl), 1200);
  } catch {
    window.prompt("复制这个地址给同一 Wi-Fi 下的其他设备：", state.lanUrl);
  }
});

els.addAttractionBtn.addEventListener("click", addAttraction);
els.addFoodBtn.addEventListener("click", addFood);
els.attractionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addAttraction();
});
els.foodInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addFood();
});

els.mealTabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-meal]");
  if (!button) return;
  state.activeMeal = button.dataset.meal;
  els.mealTabs.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
  render();
});

els.openOnly.addEventListener("change", () => render());
els.walkLimit.addEventListener("change", () => render());
els.routeBtn.addEventListener("click", () => render(true));

setDefaultTripDate();
render();
checkApiStatus();
loadCloudLibrary();
