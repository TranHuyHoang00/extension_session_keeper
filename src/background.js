// Session Keeper - service worker (Manifest V3)
//
// Ý tưởng: extension KHÔNG tự gọi API refresh token. Nó chỉ:
//   1. đọc hạn (exp) của access token trong cookie,
//   2. hẹn giờ bằng chrome.alarms trước khi token hết hạn,
//   3. reload MỘT tab của website để chính frontend tự refresh token,
//   4. theo dõi cookie để xác nhận đã có token mới,
//   5. nếu thất bại (CAPTCHA, trang đăng nhập...) thì dừng và báo người dùng.

import { getConfig, getState, setState, DEFAULT_STATE } from "./config.js";
import { getExp } from "./jwt.js";
import { detectPageState } from "./detect.js";

const ALARM_REFRESH = "sk-refresh";
const ALARM_VERIFY = "sk-verify";
const MIN_ALARM_DELAY_MS = 30_000; // Chrome không cho alarm sớm hơn 30 giây
const MANUAL_GUARD_MS = 30_000;    // chống bấm "Refresh ngay" liên tục

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

function siteHost(cfg) {
  return new URL(cfg.siteUrl).hostname;
}

function cookieDomainMatches(cookieDomain, host) {
  const d = cookieDomain.replace(/^\./, "");
  return host === d || host.endsWith("." + d);
}

async function hasHostPermission(cfg) {
  return chrome.permissions.contains({ origins: [cfg.siteUrl + "/*"] });
}

async function readTokenExp(cfg) {
  const cookie = await chrome.cookies.get({ url: cfg.siteUrl, name: cfg.tokenCookie });
  if (!cookie) return { found: false, exp: null };
  return { found: true, exp: getExp(cookie.value) };
}

async function tabExists(tabId) {
  if (tabId == null) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

const BADGE = {
  idle: { text: "", color: "#9e9e9e" },
  scheduled: { text: "", color: "#2e7d32" },
  ok: { text: "", color: "#2e7d32" },
  refreshing: { text: "…", color: "#1565c0" },
  logged_out: { text: "!", color: "#e65100" },
  needs_attention: { text: "!", color: "#c62828" },
  stopped: { text: "OFF", color: "#c62828" },
  error: { text: "ERR", color: "#c62828" },
};

async function updateBadge(status) {
  const b = BADGE[status] || BADGE.idle;
  await chrome.action.setBadgeText({ text: b.text });
  await chrome.action.setBadgeBackgroundColor({ color: b.color });
}

async function setStatus(status, message, extra = {}) {
  const prev = await getState();
  const next = await setState({ status, message, ...extra });
  await updateBadge(status);
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

async function closeWorkerTabIfOurs(state) {
  if (state.workerTabCreated && (await tabExists(state.workerTabId))) {
    try {
      await chrome.tabs.remove(state.workerTabId);
    } catch {
      /* tab đã đóng */
    }
  }
}

// ---------------------------------------------------------------------------
// Lên lịch refresh dựa trên exp của token hiện tại

async function schedule() {
  const cfg = await getConfig();
  const state = await getState();

  if (!cfg.enabled) {
    await chrome.alarms.clear(ALARM_REFRESH);
    await chrome.alarms.clear(ALARM_VERIFY);
    return setStatus("idle", "Đang tắt.", { nextRefreshAt: null });
  }
  if (!cfg.siteUrl) {
    return setStatus("idle", "Chưa cấu hình website. Mở phần Cài đặt.", { nextRefreshAt: null });
  }
  if (!(await hasHostPermission(cfg))) {
    return setStatus("error", "Chưa cấp quyền truy cập website. Mở Cài đặt và bấm Lưu.", {
      nextRefreshAt: null,
    });
  }
  // Đã dừng vì lỗi liên tiếp: chờ người dùng đăng nhập lại hoặc bấm "Đặt lại".
  if (state.status === "stopped") return state;
  // Đang chờ kiểm tra kết quả một lần refresh: không lên lịch chồng.
  if (state.status === "refreshing") return state;

  const { found, exp } = await readTokenExp(cfg);
  if (!found) {
    await chrome.alarms.clear(ALARM_REFRESH);
    return setStatus("logged_out", "Không thấy token. Hãy đăng nhập vào website.", {
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
  const message =
    status === "scheduled" ? "Đang theo dõi phiên đăng nhập." : state.message;
  return setStatus(status, message, { exp, nextRefreshAt: when });
}

// ---------------------------------------------------------------------------
// Kích hoạt website tự refresh bằng cách reload đúng MỘT tab

async function pickWorkerTab(cfg) {
  const tabs = await chrome.tabs.query({ url: cfg.siteUrl + "/*" });
  // Ưu tiên tab người dùng không đang xem, để không làm mất dữ liệu đang nhập.
  const background = tabs.find((t) => !t.active);
  if (background) return { tabId: background.id, created: false };

  const created = await chrome.tabs.create({ url: cfg.siteUrl, active: false });
  return { tabId: created.id, created: true };
}

async function startRefresh({ manual = false } = {}) {
  const cfg = await getConfig();
  const state = await getState();
  const now = Date.now();

  if (!cfg.enabled || !cfg.siteUrl) return state;
  if (state.status === "stopped" && !manual) return state;
  if (state.status === "refreshing" && state.lastAttemptAt && now - state.lastAttemptAt < cfg.verifyDelaySec * 2000) {
    return state; // đang có một lần refresh chưa xong
  }
  const gap = manual ? MANUAL_GUARD_MS : cfg.minRetryGapSec * 1000;
  if (state.lastAttemptAt && now - state.lastAttemptAt < gap) {
    // Quá sớm so với lần thử trước: lùi lịch lại thay vì reload liên tục.
    await chrome.alarms.create(ALARM_REFRESH, { when: state.lastAttemptAt + gap });
    return setState({ nextRefreshAt: state.lastAttemptAt + gap });
  }

  const { exp } = await readTokenExp(cfg);
  const { tabId, created } = await pickWorkerTab(cfg);
  try {
    // Không để Chrome "ngủ" tab này giữa chừng.
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch {
    /* một số phiên bản Chrome cũ không hỗ trợ */
  }
  if (!created) await chrome.tabs.reload(tabId);

  await setStatus("refreshing", "Đang để website tự làm mới token…", {
    lastAttemptAt: now,
    attemptExp: exp,
    workerTabId: tabId,
    workerTabCreated: created,
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
  const state = await getState();
  const { found, exp } = await readTokenExp(cfg);
  if (!found || !exp) return schedule();

  const baseline = state.status === "refreshing" ? state.attemptExp : state.exp;
  const isNewer = exp > (baseline || 0);

  if (isNewer) {
    await chrome.alarms.clear(ALARM_VERIFY);
    await closeWorkerTabIfOurs(state);
    await setState({
      status: "ok",
      failCount: 0,
      lastSuccessAt: Date.now(),
      attemptExp: null,
      workerTabId: null,
      workerTabCreated: false,
    });
  }
  return schedule();
}

// ---------------------------------------------------------------------------
// Kiểm tra kết quả sau khi reload

async function inspectTab(tabId) {
  if (!(await tabExists(tabId))) return null;
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
    // Token đã mới (có thể sự kiện cookie bị lỡ) → coi như thành công.
    return onTokenCookieChanged();
  }

  const page = await inspectTab(state.workerTabId);
  const failCount = state.failCount + 1;
  const common = { failCount, attemptExp: null };

  if (page?.captcha || page?.login) {
    // Cần người dùng thao tác: không tự thử lại, chờ cookie đổi.
    await chrome.alarms.clear(ALARM_REFRESH);
    const reason = page.captcha ? "Website yêu cầu xác minh (CAPTCHA)." : "Phiên đã hết, cần đăng nhập lại.";
    return setStatus("needs_attention", `${reason} Bấm vào thông báo để mở trang.`, {
      ...common,
      workerTabCreated: false, // giữ lại tab cho người dùng xử lý
      nextRefreshAt: null,
    });
  }

  if (failCount >= cfg.maxFailures) {
    await chrome.alarms.clear(ALARM_REFRESH);
    await closeWorkerTabIfOurs(state);
    return setStatus(
      "stopped",
      `Không làm mới được token sau ${failCount} lần thử. Đã tạm dừng, hãy kiểm tra website.`,
      { ...common, workerTabId: null, workerTabCreated: false, nextRefreshAt: null }
    );
  }

  // Thất bại chưa rõ lý do: thử lại sau minRetryGapSec.
  await closeWorkerTabIfOurs(state);
  const when = Date.now() + cfg.minRetryGapSec * 1000;
  await chrome.alarms.create(ALARM_REFRESH, { when });
  return setStatus("scheduled", `Lần thử ${failCount} chưa thành công, sẽ thử lại.`, {
    ...common,
    workerTabId: null,
    workerTabCreated: false,
    nextRefreshAt: when,
  });
}

async function resetAll() {
  await chrome.alarms.clear(ALARM_REFRESH);
  await chrome.alarms.clear(ALARM_VERIFY);
  const state = await getState();
  await closeWorkerTabIfOurs(state);
  await chrome.storage.local.set({ state: { ...DEFAULT_STATE } });
  return schedule();
}

// ---------------------------------------------------------------------------
// Đăng ký sự kiện (phải ở top-level để service worker được đánh thức đúng)

chrome.runtime.onInstalled.addListener(({ reason }) => {
  serial(schedule);
  if (reason === "install") chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => serial(schedule));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_REFRESH) serial(() => startRefresh());
  else if (alarm.name === ALARM_VERIFY) serial(verifyRefresh);
});

chrome.cookies.onChanged.addListener(({ cookie, removed, cause }) => {
  serial(async () => {
    const cfg = await getConfig();
    if (!cfg.siteUrl || cookie.name !== cfg.tokenCookie) return;
    if (!cookieDomainMatches(cookie.domain, siteHost(cfg))) return;
    // Khi cookie bị ghi đè, Chrome báo "removed" (overwrite) rồi mới báo giá trị mới.
    if (removed && cause === "overwrite") return;
    return onTokenCookieChanged();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serial(async () => {
    const state = await getState();
    if (state.workerTabId === tabId) {
      await setState({ workerTabId: null, workerTabCreated: false });
    }
  });
});

chrome.notifications.onClicked.addListener(() => {
  serial(async () => {
    const cfg = await getConfig();
    const state = await getState();
    if (await tabExists(state.workerTabId)) {
      const tab = await chrome.tabs.update(state.workerTabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } else if (cfg.siteUrl) {
      await chrome.tabs.create({ url: cfg.siteUrl, active: true });
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
    refreshNow: () => startRefresh({ manual: true }),
    reset: resetAll,
  };
  const handler = handlers[msg?.type];
  if (!handler) return false;
  serial(handler)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // trả lời bất đồng bộ
});

// Cho phép test đơn vị import các hàm này.
export const __test__ = { schedule, startRefresh, verifyRefresh, onTokenCookieChanged, cookieDomainMatches, resetAll };
