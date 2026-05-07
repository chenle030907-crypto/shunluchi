(function () {
  const STORAGE_KEY = "shunluchi.recognitionLibrary.v1";
  const LIMIT = 50;
  const button = document.querySelector("#importLibraryBtn");
  const input = document.querySelector("#importLibraryInput");

  if (!button || !input) return;

  function loadCurrentLibrary() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function hasExtractedContent(entry) {
    return Boolean(entry?.attractions?.length || entry?.foods?.length);
  }

  function normalizeText(value, maxLength = 1000) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  }

  function normalizeDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }

  function uniqueTextArray(value, maxItems, maxLength) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const items = [];

    value.forEach((item) => {
      const text = normalizeText(item, maxLength);
      if (!text || seen.has(text)) return;
      seen.add(text);
      items.push(text);
    });

    return items.slice(0, maxItems);
  }

  function getEntryKey(entry) {
    return entry.fingerprint || entry.id || `${entry.city}|${entry.source}|${entry.attractions?.join(",")}|${entry.foods?.join(",")}`;
  }

  function normalizeImportedEntry(entry, index) {
    const attractions = uniqueTextArray(entry.attractions, 30, 80);
    const foods = uniqueTextArray(entry.foods, 40, 80);
    const createdAt = normalizeDate(entry.createdAt);

    return {
      ...entry,
      id: normalizeText(entry.id, 160) || `import-${createdAt.replace(/[^0-9]/g, "")}-${index}`,
      title: normalizeText(entry.title, 180) || "导入攻略",
      source: normalizeText(entry.source, 6000),
      sourceUrl: normalizeText(entry.sourceUrl, 600),
      city: normalizeText(entry.city, 80) || "上海",
      createdAt,
      attractions,
      foods,
      notes: uniqueTextArray(entry.notes, 12, 180),
      media: Array.isArray(entry.media) ? entry.media.slice(0, 12) : [],
      entities: Array.isArray(entry.entities) ? entry.entities.slice(0, 80) : [],
      linkInspection: entry.linkInspection && typeof entry.linkInspection === "object" ? entry.linkInspection : null,
      fingerprint: normalizeText(entry.fingerprint, 700),
    };
  }

  function normalizeImportedEntries(payload) {
    const items = Array.isArray(payload) ? payload : Array.isArray(payload?.library) ? payload.library : [];
    return items
      .filter((entry) => entry && typeof entry === "object")
      .map(normalizeImportedEntry)
      .filter(hasExtractedContent);
  }

  function mergeEntries(imported, current) {
    const byKey = new Map();

    [...imported, ...current].forEach((entry) => {
      const key = getEntryKey(entry);
      const existing = byKey.get(key);
      const currentTime = new Date(entry.createdAt).getTime();
      const existingTime = existing ? new Date(existing.createdAt).getTime() : 0;

      if (!existing || currentTime >= existingTime) byKey.set(key, entry);
    });

    return [...byKey.values()]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, LIMIT);
  }

  button.addEventListener("click", () => {
    input.value = "";
    input.click();
  });

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;

    button.disabled = true;
    button.textContent = "导入中";

    try {
      const imported = normalizeImportedEntries(JSON.parse(await file.text()));
      if (!imported.length) throw new Error("empty_library");

      const merged = mergeEntries(imported, loadCurrentLibrary());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      button.textContent = `已导入 ${imported.length} 条`;
      window.setTimeout(() => window.location.reload(), 700);
    } catch (error) {
      console.warn("资料库导入失败。", error);
      window.alert("导入失败：请选择由顺路吃导出的 JSON 文件。");
      button.disabled = false;
      button.textContent = "导入 JSON";
    }
  });
})();
