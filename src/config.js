// Cấu hình và trạng thái lưu trong chrome.storage.
// Lưu ý: KHÔNG bao giờ lưu giá trị token, chỉ lưu các mốc thời gian.

export const DEFAULT_CONFIG = {
  tokenCookie: "access_token",
  marginSec: 180,           // refresh trước khi hết hạn bao nhiêu giây
  verifyDelaySec: 60,       // chờ bao lâu sau khi reload để kiểm tra token mới
  minRetryGapSec: 300,      // khoảng cách tối thiểu giữa 2 lần thử
  maxFailures: 3,           // thất bại liên tiếp bao nhiêu lần thì dừng
  enabled: true,
};

export const DEFAULT_STATE = {
  status: "unbound",        // unbound | idle | scheduled | ok | refreshing | logged_out | needs_attention | stopped | error
  message: "",
  exp: null,                // exp của access token hiện tại (giây)
  nextRefreshAt: null,      // ms
  lastAttemptAt: null,      // ms
  lastSuccessAt: null,      // ms
  failCount: 0,
  attemptExp: null,         // exp trước khi thử refresh
};

/**
 * Cấu hình đang dùng = cấu hình người dùng (sync) + tab đang gắn (local).
 * siteUrl lấy từ origin của tab đã gắn; chưa gắn tab thì siteUrl rỗng.
 */
export async function getConfig() {
  const [{ config }, binding] = await Promise.all([
    chrome.storage.sync.get("config"),
    getBinding(),
  ]);
  return {
    ...DEFAULT_CONFIG,
    ...(config || {}),
    siteUrl: binding?.origin || "",
    boundTabId: binding?.tabId ?? null,
  };
}

export async function saveConfig(patch) {
  const { config } = await chrome.storage.sync.get("config");
  const next = { ...DEFAULT_CONFIG, ...(config || {}), ...patch };
  delete next.siteUrl;
  delete next.boundTabId;
  await chrome.storage.sync.set({ config: next });
  return next;
}

// Tab đang gắn: { tabId, origin }. Lưu ở local vì tabId chỉ có nghĩa trên máy này.
export async function getBinding() {
  const { binding } = await chrome.storage.local.get("binding");
  return binding || null;
}

export async function setBinding(binding) {
  await chrome.storage.local.set({ binding });
}

export async function clearBinding() {
  await chrome.storage.local.set({ binding: null });
}

export async function getState() {
  const { state } = await chrome.storage.local.get("state");
  return { ...DEFAULT_STATE, ...(state || {}) };
}

export async function setState(patch) {
  const cur = await getState();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ state: next });
  return next;
}

/** Chuẩn hoá URL về origin; chỉ nhận https (hoặc http://localhost). */
export function normalizeOrigin(url) {
  try {
    const u = new URL(String(url).trim());
    if (u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "localhost")) {
      return null;
    }
    return u.origin;
  } catch {
    return null;
  }
}
