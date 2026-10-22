// Cấu hình và trạng thái lưu trong chrome.storage.
// Lưu ý: KHÔNG bao giờ lưu giá trị token, chỉ lưu các mốc thời gian.

export const DEFAULT_CONFIG = {
  siteUrl: "",              // ví dụ https://app.congty.vn
  tokenCookie: "access_token",
  marginSec: 180,           // refresh trước khi hết hạn bao nhiêu giây
  verifyDelaySec: 60,       // chờ bao lâu sau khi reload để kiểm tra token mới
  minRetryGapSec: 300,      // khoảng cách tối thiểu giữa 2 lần thử
  maxFailures: 3,           // thất bại liên tiếp bao nhiêu lần thì dừng
  enabled: true,
};

export const DEFAULT_STATE = {
  status: "idle",           // idle | scheduled | refreshing | ok | logged_out | needs_attention | stopped | error
  message: "",
  exp: null,                // exp của access token hiện tại (giây)
  nextRefreshAt: null,      // ms
  lastAttemptAt: null,      // ms
  lastSuccessAt: null,      // ms
  failCount: 0,
  attemptExp: null,         // exp trước khi thử refresh
  workerTabId: null,        // tab đang dùng để refresh
  workerTabCreated: false,  // tab do extension tự mở (đóng sau khi xong)
};

export async function getConfig() {
  const { config } = await chrome.storage.sync.get("config");
  return { ...DEFAULT_CONFIG, ...(config || {}) };
}

export async function saveConfig(patch) {
  const cur = await getConfig();
  const next = { ...cur, ...patch };
  await chrome.storage.sync.set({ config: next });
  return next;
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

/** Chuẩn hoá URL site về dạng origin, trả về null nếu không hợp lệ. */
export function normalizeOrigin(url) {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "localhost")) {
      return null;
    }
    return u.origin;
  } catch {
    return null;
  }
}
