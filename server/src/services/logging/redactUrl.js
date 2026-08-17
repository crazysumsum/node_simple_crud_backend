/**
 * 清理原始 URL 的 query string，避免完整 URL 欄位把敏感參數明文寫進日誌。
 *
 * Logger 的 redactedFields 黑名單只比對物件的 key 名稱，碰不到字串裡的
 * `?token=xxx` 這種內容，所以任何要記錄原始 URL 的地方都必須先呼叫這個
 * 函式，而不是依賴 Logger.write() 的通用遮蔽。
 */
export function redactUrl(url, isSensitiveField) {
  const value = String(url || "");
  const queryIndex = value.indexOf("?");

  if (queryIndex === -1) {
    return value;
  }

  const pathname = value.slice(0, queryIndex);
  const searchParams = new URLSearchParams(value.slice(queryIndex + 1));

  for (const key of new Set(searchParams.keys())) {
    if (isSensitiveField(key)) {
      searchParams.set(key, "[REDACTED]");
    }
  }

  const query = searchParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}
