// Session Keeper - service worker (Manifest V3)
//
// Có thể gắn NHIỀU tab, mỗi tab một website khác nhau (mỗi website chỉ một tab).
// Mỗi tab có trạng thái, lịch làm mới, tên cookie và log riêng, chạy độc lập.
// Extension KHÔNG tự gọi API refresh token, KHÔNG đụng tab chưa gắn và KHÔNG tự mở tab mới.
// Với mỗi tab đã gắn, nó chỉ:
//   1. đọc hạn (exp) của access token trong cookie của website đó,
//   2. hẹn giờ bằng chrome.alarms trước khi token hết hạn,
//   3. reload tab để chính frontend của website tự refresh token,
//   4. theo dõi cookie để xác nhận đã có token mới,
//   5. nếu thất bại (CAPTCHA, trang đăng nhập...) thì dừng và báo người dùng.

import {
  getConfig,
  getState,
  setState,
  replaceState,
  removeState,
  getBinding,
  getBindings,
  setBinding,
  removeBinding,
  clearAllBindings,
  findBindingByOrigin,
  getSiteSettings,
  refreshTargetMs,
  migrateLegacy,
  normalizeOrigin,
  hostOf,
} from "./config.js";
import { getExp } from "./jwt.js";
import { detectPageState } from "./detect.js";
import { log, formatTime } from "./log.js";

const ALARM_REFRESH = "sk-refresh";
const ALARM_VERIFY = "sk-verify";
const MIN_ALARM_DELAY_MS = 30_000; // Chrome không cho alarm sớm hơn 30 giây
const MANUAL_GUARD_MS = 30_000; // chống bấm "Làm mới ngay" liên tục

const alarmName = (kind, tabId) => `${kind}:${tabId}`;
function parseAlarm(name) {
  const [kind, id] = String(name).split(":");
  const tabId = Number(id);
  return Number.isInteger(tabId) ? { kind, tabId } : null;
}

// ---------------------------------------------------------------------------
// Chạy tuần tự các handler để tránh ghi đè state khi nhiều sự kiện đến cùng lúc.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch((err) => {
    console.error("[SessionKeeper]", err);
    log("error", `Lỗi không mong muốn: ${err?.message || err}`);
  });
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

// Ngữ cảnh log của một tab: { tabId, site }
async function ctxOf(tabId, origin) {
  const o = origin || (await getBinding(tabId))?.origin;
  return { tabId, site: o ? hostOf(o) : undefined };
}

async function tlog(tabId, level, msg, origin) {
  return log(level, msg, await ctxOf(tabId, origin));
}

async function clearTabAlarms(tabId) {
  await chrome.alarms.clear(alarmName(ALARM_REFRESH, tabId));
  await chrome.alarms.clear(alarmName(ALARM_VERIFY, tabId));
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

// Badge theo từng tab đã gắn; tab không gắn để trống.
async function updateBadge(tabId, status) {
  const b = BADGE[status] || BADGE.idle;
  try {
    await chrome.action.setBadgeText({ tabId, text: b.text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: b.color });
  } catch {
    /* tab đã đóng */
  }
}

const STATUS_LEVEL = {
  ok: "success",
  logged_out: "warn",
  needs_attention: "warn",
  stopped: "error",
  error: "error",
};

async function setStatus(tabId, status, message, extra = {}) {
  const prev = await getState(tabId);
  const next = await setState(tabId, { status, message, ...extra });
  // Ghi log mỗi khi trạng thái hoặc thông điệp thay đổi (không ghi trùng).
  if (message && (prev.status !== status || prev.message !== message)) {
    await tlog(tabId, STATUS_LEVEL[status] || "info", message);
  }
  await updateBadge(tabId, status);
  // Chỉ thông báo khi chuyển sang trạng thái cần người dùng xử lý.
  const alertStatuses = ["logged_out", "needs_attention", "stopped"];
  if (alertStatuses.includes(status) && prev.status !== status) {
    await notify(tabId, message);
  }
  return next;
}

async function notify(tabId, message, origin) {
  const ctx = await ctxOf(tabId, origin);
  try {
    await chrome.notifications.create(`sk-alert:${tabId}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: ctx.site ? `Session Keeper – ${ctx.site}` : "Session Keeper",
      message,
      priority: 2,
    });
  } catch (err) {
    console.warn("[SessionKeeper] notify failed", err);
    await log("warn", `Không hiện được thông báo hệ thống: ${err?.message || err}`, ctx);
  }
}

// ---------------------------------------------------------------------------
// Gắn / bỏ gắn tab

async function bindTab(tabId) {
  const tab = await getTab(tabId);
  if (!tab) throw new Error("Không tìm thấy tab.");
  const origin = normalizeOrigin(tab.pendingUrl || tab.url);
  if (!origin) throw new Error("Chỉ gắn được vào trang https.");
  if (!(await hasHostPermission(origin))) throw new Error("Chưa được cấp quyền cho website này.");

  // Mỗi website chỉ một tab: hai tab cùng website dùng chung cookie, cùng reload
  // dễ làm refresh token bị dùng lại và cả phiên bị thu hồi.
  const existing = await findBindingByOrigin(origin);
  if (existing && existing.tabId !== tabId) {
    await unbind(existing.tabId, `Website đã chuyển sang giữ ở tab #${tabId}.`);
  }
  // Tab này đang gắn website khác (người dùng đã chuyển trang rồi gắn lại).
  const current = await getBinding(tabId);
  if (current && current.origin !== origin) {
    await unbind(tabId, `Bỏ gắn ${hostOf(current.origin)} để gắn website mới.`);
  }

  await setBinding(tabId, origin);
  await tlog(tabId, "info", `Đã gắn tab #${tabId}.`, origin);
  return resetTab(tabId);
}

async function unbind(tabId, reason, { alert = false } = {}) {
  const binding = await getBinding(tabId);
  if (!binding) return null;
  await clearTabAlarms(tabId);
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  await removeBinding(tabId);
  await removeState(tabId);
  await tlog(tabId, alert ? "warn" : "info", reason, binding.origin);
  if (alert) await notify(tabId, reason, binding.origin);
  return null;
}

// ---------------------------------------------------------------------------
// Lên lịch refresh dựa trên exp của token hiện tại

async function schedule(tabId) {
  const cfg = await getConfig(tabId);
  if (!cfg) return null; // tab chưa gắn
  const state = await getState(tabId);
  const refreshAlarm = alarmName(ALARM_REFRESH, tabId);

  if (!(await getTab(tabId))) {
    return unbind(tabId, "Tab đã gắn không còn mở. Hãy gắn lại vào một tab của website.", {
      alert: true,
    });
  }
  if (!cfg.enabled) {
    await clearTabAlarms(tabId);
    return setStatus(tabId, "idle", "Đang tắt trong Cài đặt của website này.", { nextRefreshAt: null });
  }
  if (!(await hasHostPermission(cfg.siteUrl))) {
    return setStatus(tabId, "error", "Mất quyền truy cập website. Hãy gắn lại tab.", {
      nextRefreshAt: null,
    });
  }
  // Đã dừng vì lỗi liên tiếp: chờ người dùng đăng nhập lại hoặc bấm "Đặt lại".
  if (state.status === "stopped") return state;
  // Đang chờ kiểm tra kết quả một lần refresh: không lên lịch chồng.
  if (state.status === "refreshing") return state;

  const now = Date.now();
  const earliest = Math.max(
    now + MIN_ALARM_DELAY_MS,
    state.lastAttemptAt ? state.lastAttemptAt + cfg.minRetryGapSec * 1000 : 0
  );

  const { found, exp } = await readTokenExp(cfg);
  if (!found) {
    // Nhiều website đặt cookie hết hạn cùng lúc với token, nên đúng lúc token hết hạn
    // trình duyệt sẽ xoá cookie. Với kiểu "sau khi hết hạn", đó chính là lúc cần reload
    // để website gọi API, nhận lỗi và tự dùng refresh token, chứ không phải đã đăng xuất.
    const tokenJustExpired =
      cfg.timing !== "before" && state.exp && now >= state.exp * 1000 - 5000;
    if (tokenJustExpired) {
      await chrome.alarms.create(refreshAlarm, { when: earliest });
      return setStatus(
        tabId,
        "scheduled",
        `Token đã hết hạn (cookie đã bị xoá). Sẽ reload lúc ${formatTime(earliest)} để website tự làm mới.`,
        { nextRefreshAt: earliest }
      );
    }
    await chrome.alarms.clear(refreshAlarm);
    return setStatus(
      tabId,
      "logged_out",
      `Không thấy cookie "${cfg.tokenCookie}". Hãy đăng nhập hoặc kiểm tra tên cookie trong Cài đặt.`,
      { exp: null, nextRefreshAt: null }
    );
  }
  if (!exp) {
    await chrome.alarms.clear(refreshAlarm);
    return setStatus(tabId, "error", `Cookie "${cfg.tokenCookie}" không phải JWT hoặc không có exp.`, {
      exp: null,
      nextRefreshAt: null,
    });
  }

  const target = refreshTargetMs(exp, cfg);
  const when = Math.max(target, earliest);
  await chrome.alarms.create(refreshAlarm, { when });
  if (state.nextRefreshAt !== when || state.exp !== exp) {
    await tlog(
      tabId,
      "info",
      `Token hết hạn lúc ${formatTime(exp * 1000)}. Hẹn làm mới lúc ${formatTime(when)}.`
    );
  }

  // Giữ nguyên trạng thái "cần xử lý" nếu đang có, chỉ cập nhật lịch.
  const status = state.status === "needs_attention" ? "needs_attention" : "scheduled";
  const message = status === "scheduled" ? "Đang giữ phiên cho tab này." : state.message;
  return setStatus(tabId, status, message, { exp, nextRefreshAt: when });
}

async function scheduleAll() {
  const bindings = await getBindings();
  for (const b of Object.values(bindings)) await schedule(b.tabId);
}

// ---------------------------------------------------------------------------
// Reload tab đã gắn để website tự refresh

async function startRefresh(tabId, { manual = false } = {}) {
  const cfg = await getConfig(tabId);
  if (!cfg) return null;
  if (!cfg.enabled) return schedule(tabId);
  const state = await getState(tabId);
  const now = Date.now();

  await tlog(tabId, "debug", manual ? 'Người dùng bấm "Làm mới ngay".' : "Đến giờ làm mới token.");
  if (state.status === "stopped" && !manual) {
    await tlog(tabId, "debug", "Đang ở trạng thái dừng, bỏ qua.");
    return state;
  }
  if (
    state.status === "refreshing" &&
    state.lastAttemptAt &&
    now - state.lastAttemptAt < cfg.verifyDelaySec * 2000
  ) {
    await tlog(tabId, "debug", "Đang có một lần làm mới chưa xong, bỏ qua.");
    return state;
  }
  const gap = manual ? MANUAL_GUARD_MS : cfg.minRetryGapSec * 1000;
  if (state.lastAttemptAt && now - state.lastAttemptAt < gap) {
    // Quá sớm so với lần thử trước: lùi lịch lại thay vì reload liên tục.
    const when = state.lastAttemptAt + gap;
    await tlog(tabId, "warn", `Lần thử trước còn quá gần, lùi đến ${formatTime(when)}.`);
    await chrome.alarms.create(alarmName(ALARM_REFRESH, tabId), { when });
    return setState(tabId, { nextRefreshAt: when });
  }

  const tab = await getTab(tabId);
  if (!tab) {
    return unbind(tabId, "Tab đã gắn không còn mở. Hãy gắn lại vào một tab của website.", {
      alert: true,
    });
  }
  // Người dùng đã chuyển tab sang trang khác: không reload trang lạ, chờ họ quay lại.
  if (normalizeOrigin(tab.pendingUrl || tab.url) !== cfg.siteUrl) {
    const when = now + cfg.minRetryGapSec * 1000;
    await chrome.alarms.create(alarmName(ALARM_REFRESH, tabId), { when });
    return setStatus(
      tabId,
      "needs_attention",
      "Tab đã gắn đang ở trang khác. Hãy quay lại website trên tab này để extension tiếp tục.",
      { nextRefreshAt: when }
    );
  }

  const { exp } = await readTokenExp(cfg);
  try {
    // Không để Chrome "ngủ" tab này.
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch {
    /* Chrome cũ không hỗ trợ */
  }
  await chrome.tabs.reload(tabId);
  await tlog(tabId, "info", `Reload tab #${tabId} để website tự làm mới token.`);

  await setStatus(tabId, "refreshing", "Đang để website tự làm mới token…", {
    lastAttemptAt: now,
    attemptExp: exp,
    nextRefreshAt: null,
  });
  await chrome.alarms.clear(alarmName(ALARM_REFRESH, tabId));
  await chrome.alarms.create(alarmName(ALARM_VERIFY, tabId), {
    when: now + cfg.verifyDelaySec * 1000,
  });
  return getState(tabId);
}

// ---------------------------------------------------------------------------
// Khi cookie token của website thay đổi

async function onTokenCookieChanged(tabId) {
  const cfg = await getConfig(tabId);
  if (!cfg) return null;
  const state = await getState(tabId);
  const { found, exp } = await readTokenExp(cfg);
  if (!found || !exp) return schedule(tabId);

  const baseline = state.status === "refreshing" ? state.attemptExp : state.exp;
  if (exp > (baseline || 0)) {
    await tlog(tabId, "success", `Đã có token mới, hết hạn lúc ${formatTime(exp * 1000)}.`);
    await chrome.alarms.clear(alarmName(ALARM_VERIFY, tabId));
    await setState(tabId, {
      status: "ok",
      failCount: 0,
      lastSuccessAt: Date.now(),
      attemptExp: null,
    });
  }
  return schedule(tabId);
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
    await tlog(tabId, "warn", `Không kiểm tra được nội dung tab: ${err?.message || err}`);
    return null;
  }
}

async function verifyRefresh(tabId) {
  const cfg = await getConfig(tabId);
  if (!cfg) return null;
  const state = await getState(tabId);
  if (state.status !== "refreshing") return state;

  const { exp } = await readTokenExp(cfg);
  if (exp && exp > (state.attemptExp || 0)) {
    return onTokenCookieChanged(tabId); // token đã mới (sự kiện cookie có thể bị lỡ)
  }
  if (!(await getTab(tabId))) {
    return unbind(tabId, "Tab đã gắn không còn mở. Hãy gắn lại vào một tab của website.", {
      alert: true,
    });
  }

  const page = await inspectTab(tabId);
  const failCount = state.failCount + 1;
  const common = { failCount, attemptExp: null };
  await tlog(
    tabId,
    "warn",
    `Sau ${cfg.verifyDelaySec}s token vẫn chưa đổi (lần ${failCount}/${cfg.maxFailures}).` +
      (page
        ? ` Trang: ${page.path}${page.captcha ? ", có CAPTCHA" : ""}${page.login ? ", trang đăng nhập" : ""}.`
        : "")
  );

  if (page?.captcha || page?.login) {
    // Cần người dùng thao tác: không tự thử lại, chờ cookie đổi.
    await chrome.alarms.clear(alarmName(ALARM_REFRESH, tabId));
    const reason = page.captcha
      ? "Website yêu cầu xác minh (CAPTCHA)."
      : "Phiên đã hết, cần đăng nhập lại.";
    return setStatus(tabId, "needs_attention", `${reason} Bấm vào thông báo để mở tab.`, {
      ...common,
      nextRefreshAt: null,
    });
  }

  if (failCount >= cfg.maxFailures) {
    await chrome.alarms.clear(alarmName(ALARM_REFRESH, tabId));
    return setStatus(
      tabId,
      "stopped",
      `Không làm mới được token sau ${failCount} lần thử. Đã tạm dừng, hãy kiểm tra website.`,
      { ...common, nextRefreshAt: null }
    );
  }

  // Thất bại chưa rõ lý do: thử lại sau minRetryGapSec.
  const when = Date.now() + cfg.minRetryGapSec * 1000;
  await chrome.alarms.create(alarmName(ALARM_REFRESH, tabId), { when });
  return setStatus(tabId, "scheduled", `Lần thử ${failCount} chưa thành công, sẽ thử lại.`, {
    ...common,
    nextRefreshAt: when,
  });
}

async function resetTab(tabId) {
  if (!(await getBinding(tabId))) return null;
  await clearTabAlarms(tabId);
  await replaceState(tabId, { status: "idle" });
  return schedule(tabId);
}

// Khi trình duyệt khởi động lại, mọi tabId cũ đều mất hiệu lực.
async function onBrowserStartup() {
  await log("info", "Trình duyệt khởi động.");
  const bindings = Object.values(await getBindings());
  if (!bindings.length) return;
  await chrome.alarms.clearAll();
  for (const b of bindings) {
    await log("warn", "Đã bỏ gắn do trình duyệt khởi động lại.", {
      tabId: b.tabId,
      site: hostOf(b.origin),
    });
  }
  await clearAllBindings();
  await notify(
    0,
    `Trình duyệt vừa khởi động lại, đã bỏ gắn ${bindings.length} tab. Hãy mở website và gắn lại.`
  );
}

// ---------------------------------------------------------------------------
// Thông tin cho side panel của một tab

async function getStatusFor(tabId) {
  const tab = await getTab(tabId);
  const tabOrigin = tab ? normalizeOrigin(tab.pendingUrl || tab.url || "") : null;
  const binding = await getBinding(tabId);
  const siteOrigin = binding?.origin || tabOrigin;
  const bindings = Object.values(await getBindings());
  const other = tabOrigin ? bindings.find((b) => b.origin === tabOrigin && b.tabId !== tabId) : null;
  return {
    tabId,
    tabOrigin,
    binding,
    state: binding ? await getState(tabId) : null,
    settings: siteOrigin ? await getSiteSettings(siteOrigin) : null,
    settingsOrigin: siteOrigin,
    boundElsewhere: other || null,
    bound: bindings.map((b) => ({ tabId: b.tabId, site: hostOf(b.origin) })),
  };
}

// ---------------------------------------------------------------------------
// Side panel theo từng tab
//
// Mặc định side panel bị TẮT cho mọi tab. Bấm icon extension ở tab nào thì chỉ bật
// side panel cho đúng tab đó, nên mở tab mới sẽ không thấy panel.

const PANEL_PATH = "src/panel/panel.html";

function panelPathFor(tabId) {
  return `${PANEL_PATH}?tabId=${tabId}`;
}

async function disablePanelGlobally() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  await chrome.sidePanel.setOptions({ enabled: false });
}

// Bấm icon extension trên website = đồng ý giữ phiên cho tab đó: mở panel và gắn luôn.
// Không dùng await trước sidePanel.open: Chrome chỉ cho mở panel ngay trong lần bấm của người dùng.
function openPanelForTab(tab) {
  if (!tab?.id) return;
  chrome.sidePanel.setOptions({ tabId: tab.id, path: panelPathFor(tab.id), enabled: true });
  chrome.sidePanel.open({ tabId: tab.id }).catch((err) => {
    console.warn("[SessionKeeper] open side panel failed", err);
    log("error", `Không mở được side panel: ${err?.message || err}`, { tabId: tab.id });
  });
  return serial(() => autoBind(tab.id));
}

async function autoBind(tabId) {
  const tab = await getTab(tabId);
  const origin = tab ? normalizeOrigin(tab.pendingUrl || tab.url || "") : null;
  if (!origin) return null; // trang không phải https: panel sẽ giải thích
  const current = await getBinding(tabId);
  if (current?.origin === origin) return getState(tabId); // đã gắn rồi: không đặt lại
  return bindTab(tabId);
}

// ---------------------------------------------------------------------------
// Đăng ký sự kiện (phải ở top-level để service worker được đánh thức đúng)

chrome.action.onClicked.addListener(openPanelForTab);

chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  const version = chrome.runtime.getManifest?.().version || "";
  log(
    "info",
    reason === "update"
      ? `Đã cập nhật extension ${previousVersion} → ${version}.`
      : `Extension được cài đặt/tải lại (${reason}) ${version}.`
  );
  serial(async () => {
    if (await migrateLegacy()) await log("info", "Đã chuyển dữ liệu từ phiên bản cũ.");
  });
  serial(disablePanelGlobally);
  serial(scheduleAll);
});

chrome.runtime.onStartup.addListener(() => {
  serial(disablePanelGlobally);
  serial(onBrowserStartup);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  const a = parseAlarm(alarm.name);
  if (!a) return;
  if (a.kind === ALARM_REFRESH) serial(() => startRefresh(a.tabId));
  else if (a.kind === ALARM_VERIFY) serial(() => verifyRefresh(a.tabId));
});

// Cookie thay đổi chỉ tác động tới tab của đúng website đó, theo đúng tên cookie của website.
chrome.cookies.onChanged.addListener(({ cookie, removed, cause }) => {
  serial(async () => {
    // Khi cookie bị ghi đè, Chrome báo "removed" (overwrite) rồi mới báo giá trị mới.
    if (removed && cause === "overwrite") return;
    const bindings = Object.values(await getBindings());
    for (const b of bindings) {
      const site = await getSiteSettings(b.origin);
      if (cookie.name !== site.tokenCookie) continue;
      if (!cookieDomainMatches(cookie.domain, new URL(b.origin).hostname)) continue;
      await tlog(
        b.tabId,
        "debug",
        removed ? `Cookie token bị xoá (${cause}).` : "Cookie token vừa được ghi mới."
      );
      await onTokenCookieChanged(b.tabId);
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serial(() =>
    unbind(tabId, "Tab đã gắn vừa bị đóng. Đã ngừng giữ phiên cho website này.", { alert: true })
  );
});

// Chrome xoá badge theo tab mỗi khi tab tải trang mới, nên đặt lại sau khi tải xong.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return;
  serial(async () => {
    if (!(await getBinding(tabId))) return;
    const state = await getState(tabId);
    await updateBadge(tabId, state.status);
  });
});

chrome.notifications.onClicked.addListener((notificationId) => {
  serial(async () => {
    const tabId = Number(String(notificationId).split(":")[1]);
    const tab = await getTab(tabId);
    if (tab) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    await chrome.notifications.clear(notificationId);
  });
});

// Đổi cài đặt của một website → khởi động lại theo dõi cho tab của website đó.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.sites) return;
  const before = changes.sites.oldValue || {};
  const after = changes.sites.newValue || {};
  const origins = new Set([...Object.keys(before), ...Object.keys(after)]);
  serial(async () => {
    for (const origin of origins) {
      if (JSON.stringify(before[origin]) === JSON.stringify(after[origin])) continue;
      const b = await findBindingByOrigin(origin);
      if (!b) continue;
      await tlog(b.tabId, "info", "Đã lưu cài đặt mới, khởi động lại theo dõi.");
      await resetTab(b.tabId);
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const tabId = Number(msg?.tabId);
  const handlers = {
    getStatus: () => getStatusFor(tabId),
    bind: () => bindTab(tabId),
    unbind: () => unbind(tabId, "Đã bỏ gắn tab."),
    refreshNow: () => startRefresh(tabId, { manual: true }),
    reset: async () => {
      await tlog(tabId, "info", 'Người dùng bấm "Đặt lại".');
      return resetTab(tabId);
    },
  };
  const handler = handlers[msg?.type];
  if (!handler || !Number.isInteger(tabId)) return false;
  serial(handler)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true; // trả lời bất đồng bộ
});

// Bắt lỗi chưa xử lý trong service worker để hiện trong lịch sử.
if (typeof self !== "undefined" && self.addEventListener) {
  self.addEventListener("error", (e) => log("error", `Lỗi: ${e?.message || e}`));
  self.addEventListener("unhandledrejection", (e) =>
    log("error", `Lỗi chưa xử lý: ${e?.reason?.message || e?.reason || e}`)
  );
}

// Cho phép test đơn vị gọi trực tiếp các hàm này.
export const __test__ = {
  schedule,
  scheduleAll,
  startRefresh,
  verifyRefresh,
  onTokenCookieChanged,
  cookieDomainMatches,
  resetTab,
  bindTab,
  unbind,
  onBrowserStartup,
  openPanelForTab,
  disablePanelGlobally,
  getStatusFor,
  parseAlarm,
};
