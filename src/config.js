// Cấu hình và trạng thái lưu trong chrome.storage.
// Lưu ý: KHÔNG bao giờ lưu giá trị token, chỉ lưu các mốc thời gian.
//
// Dữ liệu:
//   sync.sites     { [origin]: { tokenCookie, marginSec, enabled } }   cài đặt theo website
//   local.bindings { [tabId]: { tabId, origin } }                      tab đang gắn (mỗi website 1 tab)
//   local.states   { [tabId]: state }                                  trạng thái theo tab

// Thông số chung (nâng cao) cho mọi website.
export const DEFAULTS = {
  verifyDelaySec: 60, // chờ bao lâu sau khi reload để kiểm tra token mới
  minRetryGapSec: 300, // khoảng cách tối thiểu giữa 2 lần thử
  maxFailures: 3, // thất bại liên tiếp bao nhiêu lần thì dừng
};

// Cài đặt mặc định của một website.
export const DEFAULT_SITE = {
  tokenCookie: "privateToken",
  // Khi nào reload tab:
  //   "after"  : SAU khi token hết hạn. Dành cho website chỉ refresh khi gọi API bị lỗi 401
  //              (token hết hạn → API lỗi → frontend mới dùng refresh token). Đây là kiểu phổ biến.
  //   "before" : TRƯỚC khi token hết hạn. Dành cho website tự refresh chủ động lúc tải trang.
  timing: "after",
  afterSec: 10, // (after) chờ bao nhiêu giây sau khi token hết hạn rồi mới reload
  marginSec: 180, // (before) reload trước khi hết hạn bao nhiêu giây
  enabled: true,
};

/** Thời điểm (ms) nên reload tab để website làm mới token. */
export function refreshTargetMs(exp, site) {
  return site.timing === "before"
    ? (exp - site.marginSec) * 1000
    : (exp + site.afterSec) * 1000;
}

export function describeTiming(site) {
  return site.timing === "before"
    ? `Trước khi hết hạn ${site.marginSec}s`
    : `Sau khi hết hạn ${site.afterSec}s (khi API báo lỗi)`;
}

export const DEFAULT_STATE = {
  status: "unbound", // unbound | idle | scheduled | ok | refreshing | logged_out | needs_attention | stopped | error
  message: "",
  exp: null, // exp của access token hiện tại (giây)
  nextRefreshAt: null, // ms
  lastAttemptAt: null, // ms
  lastSuccessAt: null, // ms
  failCount: 0,
  attemptExp: null, // exp trước khi thử refresh
};

const key = (tabId) => String(tabId);

// ---------------------------------------------------------------------------
// Cài đặt theo website

export async function getAllSites() {
  const { sites } = await chrome.storage.sync.get("sites");
  return sites || {};
}

export async function getSiteSettings(origin) {
  const sites = await getAllSites();
  return { ...DEFAULT_SITE, ...(sites[origin] || {}) };
}

export async function saveSiteSettings(origin, patch) {
  const sites = await getAllSites();
  sites[origin] = { ...DEFAULT_SITE, ...(sites[origin] || {}), ...patch };
  await chrome.storage.sync.set({ sites });
  return sites[origin];
}

// ---------------------------------------------------------------------------
// Tab đang gắn

export async function getBindings() {
  const { bindings } = await chrome.storage.local.get("bindings");
  return bindings || {};
}

export async function getBinding(tabId) {
  const bindings = await getBindings();
  return bindings[key(tabId)] || null;
}

export async function findBindingByOrigin(origin) {
  const bindings = await getBindings();
  return Object.values(bindings).find((b) => b.origin === origin) || null;
}

export async function setBinding(tabId, origin) {
  const bindings = await getBindings();
  bindings[key(tabId)] = { tabId, origin };
  await chrome.storage.local.set({ bindings });
}

export async function removeBinding(tabId) {
  const bindings = await getBindings();
  delete bindings[key(tabId)];
  await chrome.storage.local.set({ bindings });
}

export async function clearAllBindings() {
  await chrome.storage.local.set({ bindings: {}, states: {} });
}

// ---------------------------------------------------------------------------
// Cấu hình đầy đủ của một tab = thông số chung + cài đặt website + thông tin gắn.
// Trả về null nếu tab chưa gắn.

export async function getConfig(tabId) {
  const binding = await getBinding(tabId);
  if (!binding) return null;
  const site = await getSiteSettings(binding.origin);
  return { ...DEFAULTS, ...site, siteUrl: binding.origin, tabId: binding.tabId };
}

// ---------------------------------------------------------------------------
// Trạng thái theo tab

export async function getAllStates() {
  const { states } = await chrome.storage.local.get("states");
  return states || {};
}

export async function getState(tabId) {
  const states = await getAllStates();
  return { ...DEFAULT_STATE, ...(states[key(tabId)] || {}) };
}

export async function setState(tabId, patch) {
  const states = await getAllStates();
  const next = { ...DEFAULT_STATE, ...(states[key(tabId)] || {}), ...patch };
  states[key(tabId)] = next;
  await chrome.storage.local.set({ states });
  return next;
}

export async function replaceState(tabId, state) {
  const states = await getAllStates();
  states[key(tabId)] = { ...DEFAULT_STATE, ...state };
  await chrome.storage.local.set({ states });
  return states[key(tabId)];
}

export async function removeState(tabId) {
  const states = await getAllStates();
  delete states[key(tabId)];
  await chrome.storage.local.set({ states });
}

// ---------------------------------------------------------------------------
// Chuyển dữ liệu từ phiên bản cũ (chỉ gắn 1 tab) sang dạng nhiều tab.

export async function migrateLegacy() {
  const local = await chrome.storage.local.get(["binding", "state"]);
  const sync = await chrome.storage.sync.get("config");
  const legacyBinding = local.binding;
  const legacyConfig = sync.config;

  if (legacyBinding?.origin) {
    if (legacyConfig) {
      const { tokenCookie, marginSec, enabled } = legacyConfig;
      await saveSiteSettings(legacyBinding.origin, {
        ...(tokenCookie ? { tokenCookie } : {}),
        ...(marginSec ? { marginSec } : {}),
        ...(typeof enabled === "boolean" ? { enabled } : {}),
      });
    }
    await setBinding(legacyBinding.tabId, legacyBinding.origin);
    if (local.state) await replaceState(legacyBinding.tabId, local.state);
  }
  if ("binding" in local || "state" in local) {
    await chrome.storage.local.remove(["binding", "state"]);
  }
  if (legacyConfig) await chrome.storage.sync.remove("config");
  return Boolean(legacyBinding?.origin);
}

/** Chuẩn hoá URL về origin; chỉ nhận https (hoặc http://localhost). */
export function normalizeOrigin(url) {
  try {
    const u = new URL(String(url).trim());
    if (
      u.protocol !== "https:" &&
      !(u.protocol === "http:" && u.hostname === "localhost")
    ) {
      return null;
    }
    return u.origin;
  } catch {
    return null;
  }
}

export function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
}
