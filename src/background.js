// Session Keeper - service worker (Manifest V3)
//
// Extension chỉ làm việc với ĐÚNG MỘT tab mà người dùng đã gắn (bấm icon → "Gắn vào tab này").
// Nó KHÔNG tự gọi API refresh token, KHÔNG đụng tab khác và KHÔNG tự mở tab mới. Nó chỉ:
//   1. đọc hạn (exp) của access token trong cookie,
//   2. hẹn giờ bằng chrome.alarms trước khi token hết hạn,
//   3. reload tab đã gắn để chính frontend của website tự refresh token,
//   4. theo dõi cookie để xác nhận đã có token mới,
//   5. nếu thất bại (CAPTCHA, trang đăng nhập...) thì dừng và báo người dùng.

import {
  getConfig,
  getState,
  setState,
  setBinding,
  clearBinding,
  normalizeOrigin,
  DEFAULT_STATE,
} from "./config.js";
import { getExp } from "./jwt.js";
import { detectPageState } from "./detect.js";

const ALARM_REFRESH = "sk-refresh";
const ALARM_VERIFY = "sk-verify";
const MIN_ALARM_DELAY_MS = 30_000; // Chrome không cho alarm sớm hơn 30 giây
const MANUAL_GUARD_MS = 30_000;    // chống bấm "Làm mới ngay" liên tục

// ---------------------------------------------------------------------------
// Chạy tuần tự các handler để tránh ghi đè state khi nhiều sự kiện đến cùng lúc.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch((err) => console.error("[SessionKeeper]", err));
  return run;
}

// ---------------------------------------------------------------------------
// Tiện ích

function cookieDomainMatches(cookieDomain, host) {
  const d = cookieDomain.replace(/^\./, "");
  return host === d || host.endsWith("." + d);
}

async function hasHostPermission(origin) {
  return chrome.permissions.contains({ origins: [origin + "/*"] });
}

async function readTokenExp(cfg) {
  const cookie = await chrome.cookies.get({ url: cfg.siteUrl, name: cfg.tokenCookie });
  if (!cookie) return { found: false, exp: null };
  return { found: true, exp: getExp(cookie.value) };
}

async function getTab(tabId) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

const BADGE = {
  unbound: { text: "", color: "#9e9e9e" },
  idle: { text: "", color: "#9e9e9e" },
  scheduled: { text: "ON", color: "#2e7d32" },
  ok: { text: "ON", color: "#2e7d32" },
  refreshing: { text: "…", color: "#1565c0" },
  logged_out: { text: "!", color: "#e65100" },
  needs_attention: { text: "!", color: "#c62828" },
  stopped: { text: "OFF", color: "#c62828" },
  error: { text: "ERR", color: "#c62828" },
};

// Badge chỉ hiện trên tab đã gắn, các tab khác để trống.
async function updateBadge(status, tabId) {
  await chrome.action.setBadgeText({ text: "" });
  if (tabId == null) return;
  const b = BADGE[status] || BADGE.idle;
  try {
    await chrome.action.setBadgeText({ tabId, text: b.text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: b.color });
  } catch {
    /* tab đã đóng */
  }
}

async function setStatus(status, message, extra = {}) {
  const prev = await getState();
  const next = await setState({ status, message, ...extra });
  const cfg = await getConfig();
  await updateBadge(status, cfg.boundTabId);
  // Chỉ thông báo khi chuyển sang trạng thái cần người dùng xử lý.
  const alertStatuses = ["logged_out", "needs_attention", "stopped"];
  if (alertStatuses.includes(status) && prev.status !== status) {
    await notify(message);
  }
  return next;
}

async function notify(message) {
  try {
    await chrome.notifications.create("sk-alert", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "Session Keeper",
      message,
      priority: 2,
    });
  } catch (err) {
    console.warn("[SessionKeeper] notify failed", err);
  }
}

// ---------------------------------------------------------------------------
// Gắn / bỏ gắn tab

async function bindTab(tabId) {
  const tab = await getTab(tabId);
  if (!tab) throw new Error("Không tìm thấy tab.");
  const origin = normalizeOrigin(tab.url);
  if (!origin) throw new Error("Chỉ gắn được vào trang https.");
  if (!(await hasHostPermission(origin))) throw new Error("Chưa được cấp quyền cho website này.");

  const cfg = await getConfig();
  if (cfg.boundTabId != null && cfg.boundTabId !== tabId) {
    await chrome.action.setBadgeText({ tabId: cfg.boundTabId, text: "" }).catch(() => {});
  }
  await setBinding({ tabId, origin });
  return resetAll();
}

async function unbind(reason, { alert = false } = {}) {
  const cfg = await getConfig();
  await chrome.alarms.clear(ALARM_REFRESH);
  await chrome.alarms.clear(ALARM_VERIFY);
  if (cfg.boundTabId != null) {
    await chrome.action.setBadgeText({ tabId: cfg.boundTabId, text: "" }).catch(() => {});
  }
  await clearBinding();
  await chrome.storage.local.set({ state: { ...DEFAULT_STATE, message: reason } });
  await updateBadge("unbound", null);
  if (alert) await notify(reason);
  return getState();
}

// ---------------------------------------------------------------------------
// Lên lịch refresh dựa trên exp của token hiện tại

async function schedule() {
  const cfg = await getConfig();
  const state = await getState();

  if (cfg.boundTabId == null) {
    await chrome.alarms.clear(ALARM_REFRESH);
    return setStatus("unbound", state.message || "Chưa gắn tab. Mở website, bấm icon extension và chọn \"Gắn vào tab này\".", {
      nextRefreshAt: null,
    });
  }
  if (!(await getTab(cfg.boundTabId))) {
    return unbind("Tab đã gắn không còn mở. Hãy gắn lại vào một tab của website.", { alert: true });
  }
  if (!cfg.enabled) {
    await chrome.alarms.clear(ALARM_REFRESH);
    await chrome.alarms.clear(ALARM_VERIFY);
    return setStatus("idle", "Đang tắt trong Cài đặt.", { nextRefreshAt: null });
  }
  if (!(await hasHostPermission(cfg.siteUrl))) {
    return setStatus("error", "Mất quyền truy cập website. Hãy gắn lại tab.", { nextRefreshAt: null });
  }
  // Đã dừng vì lỗi liên tiếp: chờ người dùng đăng nhập lại hoặc bấm "Đặt lại".
  if (state.status === "stopped") return state;
  // Đang chờ kiểm tra kết quả một lần refresh: không lên lịch chồng.
  if (state.status === "refreshing") return state;

  const { found, exp } = await readTokenExp(cfg);
  if (!found) {
    await chrome.alarms.clear(ALARM_REFRESH);
    return setStatus("logged_out", "Không thấy token. Hãy đăng nhập vào website trên tab đã gắn.", {
      exp: null,
      nextRefreshAt: null,
    });
  }
  if (!exp) {
    await chrome.alarms.clear(ALARM_REFRESH);
    return setStatus("error", `Cookie "${cfg.tokenCookie}" không phải JWT hoặc không có exp.`, {
      exp: null,
      nextRefreshAt: null,
    });
  }

  const now = Date.now();
  const target = (exp - cfg.marginSec) * 1000;
  const earliest = Math.max(
    now + MIN_ALARM_DELAY_MS,
    state.lastAttemptAt ? state.lastAttemptAt + cfg.minRetryGapSec * 1000 : 0
  );
  const when = Math.max(target, earliest);
  await chrome.alarms.create(ALARM_REFRESH, { when });

  // Giữ nguyên trạng thái "cần xử lý" nếu đang có, chỉ cập nhật lịch.
  const status = state.status === "needs_attention" ? "needs_attention" : "scheduled";
  const message = status === "scheduled" ? "Đang giữ phiên cho tab đã gắn." : state.message;
  return setStatus(status, message, { exp, nextRefreshAt: when });
}

// ---------------------------------------------------------------------------
// Reload tab đã gắn để website tự refresh

async function startRefresh({ manual = false } = {}) {
  const cfg = await getConfig();
  const state = await getState();
  const now = Date.now();

  if (cfg.boundTabId == null || !cfg.enabled) return schedule();
  if (state.status === "stopped" && !manual) return state;
  if (
    state.status === "refreshing" &&
    state.lastAttemptAt &&
    now - state.lastAttemptAt < cfg.verifyDelaySec * 2000
  ) {
    return state; // đang có một lần refresh chưa xong
  }
  const gap = manual ? MANUAL_GUARD_MS : cfg.minRetryGapSec * 1000;
  if (state.lastAttemptAt && now - state.lastAttemptAt < gap) {
    // Quá sớm so với lần thử trước: lùi lịch lại thay vì reload liên tục.
    await chrome.alarms.create(ALARM_REFRESH, { when: state.lastAttemptAt + gap });
    return setState({ nextRefreshAt: state.lastAttemptAt + gap });
  }

  const tab = await getTab(cfg.boundTabId);
  if (!tab) {
    return unbind("Tab đã gắn không còn mở. Hãy gắn lại vào một tab của website.", { alert: true });
  }
  // Người dùng đã chuyển tab sang trang khác: không reload trang lạ, chờ họ quay lại.
  if (normalizeOrigin(tab.pendingUrl || tab.url) !== cfg.siteUrl) {
    const when = now + cfg.minRetryGapSec * 1000;
    await chrome.alarms.create(ALARM_REFRESH, { when });
    return setStatus(
      "needs_attention",
      "Tab đã gắn đang ở trang khác. Hãy quay lại website trên tab này để extension tiếp tục.",
      { nextRefreshAt: when }
    );
  }

  const { exp } = await readTokenExp(cfg);
  try {
    // Không để Chrome "ngủ" tab này.
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
  } catch {
    /* Chrome cũ không hỗ trợ */
  }
  await chrome.tabs.reload(tab.id);

  await setStatus("refreshing", "Đang để website tự làm mới token…", {
    lastAttemptAt: now,
    attemptExp: exp,
    nextRefreshAt: null,
  });
  await chrome.alarms.clear(ALARM_REFRESH);
  await chrome.alarms.create(ALARM_VERIFY, { when: now + cfg.verifyDelaySec * 1000 });
  return getState();
}

// ---------------------------------------------------------------------------
// Khi cookie token thay đổi

async function onTokenCookieChanged() {
  const cfg = await getConfig();
  if (cfg.boundTabId == null) return getState();
  const state = await getState();
  const { found, exp } = await readTokenExp(cfg);
  if (!found || !exp) return schedule();

  const baseline = state.status === "refreshing" ? state.attemptExp : state.exp;
  if (exp > (baseline || 0)) {
    await chrome.alarms.clear(ALARM_VERIFY);
    await setState({
      status: "ok",
      failCount: 0,
      lastSuccessAt: Date.now(),
      attemptExp: null,
    });
  }
  return schedule();
}

// ---------------------------------------------------------------------------
// Kiểm tra kết quả sau khi reload

async function inspectTab(tabId) {
  if (!(await getTab(tabId))) return null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: detectPageState,
    });
    return res?.result || null;
  } catch (err) {
    console.warn("[SessionKeeper] inspect failed", err);
    return null;
  }
}

async function verifyRefresh() {
  const cfg = await getConfig();
  const state = await getState();
  if (state.status !== "refreshing") return state;

  const { exp } = await readTokenExp(cfg);
  if (exp && exp > (state.attemptExp || 0)) {
    return onTokenCookieChanged(); // token đã mới (sự kiện cookie có thể bị lỡ)
  }
  if (!(await getTab(cfg.boundTabId))) {
    return unbind("Tab đã gắn không còn mở. Hãy gắn lại vào một tab của website.", { alert: true });
  }

  const page = await inspectTab(cfg.boundTabId);
  const failCount = state.failCount + 1;
  const common = { failCount, attemptExp: null };

  if (page?.captcha || page?.login) {
    // Cần người dùng thao tác: không tự thử lại, chờ cookie đổi.
    await chrome.alarms.clear(ALARM_REFRESH);
    const reason = page.captcha
      ? "Website yêu cầu xác minh (CAPTCHA)."
      : "Phiên đã hết, cần đăng nhập lại.";
    return setStatus("needs_attention", `${reason} Bấm vào thông báo để mở tab.`, {
      ...common,
      nextRefreshAt: null,
    });
  }

  if (failCount >= cfg.maxFailures) {
    await chrome.alarms.clear(ALARM_REFRESH);
    return setStatus(
      "stopped",
      `Không làm mới được token sau ${failCount} lần thử. Đã tạm dừng, hãy kiểm tra website.`,
      { ...common, nextRefreshAt: null }
    );
  }

  // Thất bại chưa rõ lý do: thử lại sau minRetryGapSec.
  const when = Date.now() + cfg.minRetryGapSec * 1000;
  await chrome.alarms.create(ALARM_REFRESH, { when });
  return setStatus("scheduled", `Lần thử ${failCount} chưa thành công, sẽ thử lại.`, {
    ...common,
    nextRefreshAt: when,
  });
}

async function resetAll() {
  await chrome.alarms.clear(ALARM_REFRESH);
  await chrome.alarms.clear(ALARM_VERIFY);
  await chrome.storage.local.set({ state: { ...DEFAULT_STATE, status: "idle" } });
  return schedule();
}

// Khi trình duyệt khởi động lại, mọi tabId cũ đều mất hiệu lực.
async function onBrowserStartup() {
  const cfg = await getConfig();
  if (cfg.boundTabId == null) return schedule();
  return unbind("Trình duyệt vừa khởi động lại. Hãy mở website và gắn lại tab.", { alert: true });
}

// ---------------------------------------------------------------------------
// Đăng ký sự kiện (phải ở top-level để service worker được đánh thức đúng)

chrome.runtime.onInstalled.addListener(({ reason }) => {
  serial(schedule);
  if (reason === "install") chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => serial(onBrowserStartup));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_REFRESH) serial(() => startRefresh());
  else if (alarm.name === ALARM_VERIFY) serial(verifyRefresh);
});

chrome.cookies.onChanged.addListener(({ cookie, removed, cause }) => {
  serial(async () => {
    const cfg = await getConfig();
    if (!cfg.siteUrl || cookie.name !== cfg.tokenCookie) return;
    if (!cookieDomainMatches(cookie.domain, new URL(cfg.siteUrl).hostname)) return;
    // Khi cookie bị ghi đè, Chrome báo "removed" (overwrite) rồi mới báo giá trị mới.
    if (removed && cause === "overwrite") return;
    return onTokenCookieChanged();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serial(async () => {
    const cfg = await getConfig();
    if (cfg.boundTabId === tabId) {
      await unbind("Tab đã gắn vừa bị đóng. Extension đã ngừng giữ phiên.", { alert: true });
    }
  });
});

// Chrome xoá badge theo tab mỗi khi tab tải trang mới, nên đặt lại sau khi tải xong.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return;
  serial(async () => {
    const cfg = await getConfig();
    if (cfg.boundTabId !== tabId) return;
    const state = await getState();
    await updateBadge(state.status, tabId);
  });
});

chrome.notifications.onClicked.addListener(() => {
  serial(async () => {
    const cfg = await getConfig();
    const tab = await getTab(cfg.boundTabId);
    if (tab) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    await chrome.notifications.clear("sk-alert");
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.config) serial(resetAll);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    getStatus: async () => ({ state: await getState(), config: await getConfig() }),
    bind: () => bindTab(msg.tabId),
    unbind: () => unbind("Đã bỏ gắn tab."),
    refreshNow: () => startRefresh({ manual: true }),
    reset: resetAll,
  };
  const handler = handlers[msg?.type];
  if (!handler) return false;
  serial(handler)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true; // trả lời bất đồng bộ
});

// Cho phép test đơn vị gọi trực tiếp các hàm này.
export const __test__ = {
  schedule,
  startRefresh,
  verifyRefresh,
  onTokenCookieChanged,
  cookieDomainMatches,
  resetAll,
  bindTab,
  unbind,
  onBrowserStartup,
};
