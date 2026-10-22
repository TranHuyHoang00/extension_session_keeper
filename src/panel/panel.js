import { normalizeOrigin, getConfig, saveConfig } from "../config.js";
import { getExp } from "../jwt.js";
import { LOG_KEY, getLogs, clearLogs, formatTime, formatLine, logError } from "../log.js";

const STATUS_LABEL = {
  unbound: "Chưa gắn tab",
  idle: "Đang tắt",
  scheduled: "Đang giữ phiên",
  ok: "Ổn định",
  refreshing: "Đang làm mới",
  logged_out: "Chưa đăng nhập",
  needs_attention: "Cần xử lý",
  stopped: "Đã dừng",
  error: "Lỗi",
};

const $ = (id) => document.getElementById(id);
let currentTab = null;
let currentOrigin = null;

function fmt(ms) {
  if (!ms) return "–";
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const rel =
    abs < 60_000 ? "vài giây" : abs < 3_600_000 ? `${Math.round(abs / 60_000)} phút` : `${(abs / 3_600_000).toFixed(1)} giờ`;
  return `${new Date(ms).toLocaleString("vi-VN")} (${diff >= 0 ? "còn " + rel : rel + " trước"})`;
}

async function send(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  if (!res?.ok) throw new Error(res?.error || "Không có phản hồi");
  return res.result;
}

function show(el, visible) {
  el.hidden = !visible;
}

async function render() {
  const { state, config } = await send("getStatus");
  const bound = config.boundTabId != null;
  const isThisTab = bound && currentTab?.id === config.boundTabId;

  $("status").textContent = STATUS_LABEL[state.status] || state.status;
  $("status").dataset.status = state.status;
  $("message").textContent = state.message || "";

  // Khu vực gắn tab
  if (isThisTab) {
    $("bindText").textContent = "Extension đang giữ phiên cho tab này.";
  } else if (bound) {
    $("bindText").textContent = "Extension đang gắn với một tab khác.";
  } else if (currentOrigin) {
    $("bindText").textContent = "Gắn extension vào tab này để giữ phiên đăng nhập.";
  } else {
    $("bindText").textContent = "Hãy mở website (https) cần giữ phiên rồi bấm lại icon này.";
  }
  show($("bind"), !isThisTab && !!currentOrigin);
  $("bind").textContent = bound ? "Chuyển sang tab này" : "Gắn vào tab này";
  show($("unbind"), bound);
  show($("goto"), bound && !isThisTab);

  // Thông tin chi tiết chỉ có ý nghĩa khi đã gắn
  show($("facts"), bound);
  $("site").textContent = config.siteUrl || "–";
  $("exp").textContent = state.exp ? fmt(state.exp * 1000) : "–";
  $("next").textContent = fmt(state.nextRefreshAt);
  $("last").textContent = fmt(state.lastSuccessAt);
  $("fails").textContent = String(state.failCount);

  show($("refresh"), bound);
  show($("reset"), bound);
  $("refresh").disabled = !config.enabled || state.status === "refreshing";
}

async function act(type, extra) {
  try {
    await send(type, extra);
  } catch (err) {
    $("message").textContent = err.message || String(err);
    logError(err.message || String(err));
    return render().then(() => ($("message").textContent = err.message || String(err)));
  }
  await render();
}

$("bind").addEventListener("click", () => {
  if (!currentTab || !currentOrigin) return;
  // permissions.request phải gọi ngay trong lần bấm của người dùng.
  chrome.permissions.request({ origins: [currentOrigin + "/*"] }, (granted) => {
    if (!granted) {
      $("message").textContent = "Bạn chưa cấp quyền cho website này nên không thể gắn.";
      return;
    }
    act("bind", { tabId: currentTab.id });
  });
});
$("unbind").addEventListener("click", () => act("unbind"));
$("goto").addEventListener("click", async () => {
  const { config } = await send("getStatus");
  const tab = await chrome.tabs.update(config.boundTabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
});
$("refresh").addEventListener("click", () => act("refreshNow"));
$("reset").addEventListener("click", () => act("reset"));
// ---------------------------------------------------------------------------
// Cài đặt ngay trong panel

const showSettingsResult = (text, kind = "") => {
  $("settingsResult").textContent = text;
  $("settingsResult").dataset.kind = kind;
};

async function openSettings() {
  const cfg = await getConfig();
  $("tokenCookie").value = cfg.tokenCookie;
  $("marginSec").value = cfg.marginSec;
  $("enabled").checked = cfg.enabled;
  showSettingsResult("");
  show($("mainView"), false);
  show($("settingsView"), true);
}

function closeSettings() {
  show($("settingsView"), false);
  show($("mainView"), true);
  tick();
}

$("openSettings").addEventListener("click", openSettings);
$("closeSettings").addEventListener("click", closeSettings);

$("settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveConfig({
    tokenCookie: $("tokenCookie").value.trim(),
    marginSec: Math.max(60, Number($("marginSec").value) || 180),
    enabled: $("enabled").checked,
  });
  showSettingsResult("Đã lưu.", "ok");
});

$("checkCookie").addEventListener("click", async () => {
  const cfg = await getConfig();
  const name = $("tokenCookie").value.trim();
  if (!cfg.siteUrl) return showSettingsResult("Chưa gắn tab nào. Quay lại và bấm \"Gắn vào tab này\" trước.", "error");
  if (!name) return showSettingsResult("Nhập tên cookie trước.", "error");
  const cookie = await chrome.cookies.get({ url: cfg.siteUrl, name });
  if (!cookie) return showSettingsResult(`Không tìm thấy cookie "${name}" trên ${cfg.siteUrl}. Bạn đã đăng nhập chưa?`, "error");
  const exp = getExp(cookie.value);
  if (!exp) return showSettingsResult(`Cookie "${name}" không phải JWT hoặc không có trường exp.`, "error");
  showSettingsResult(`Tìm thấy token. Hết hạn lúc ${new Date(exp * 1000).toLocaleString("vi-VN")}.`, "ok");
});

// Side panel được mở riêng cho một tab; tabId nằm trong URL của panel.
const PANEL_TAB_ID = Number(new URLSearchParams(location.search).get("tabId"));

async function loadTab() {
  try {
    currentTab = Number.isInteger(PANEL_TAB_ID) && PANEL_TAB_ID > 0
      ? await chrome.tabs.get(PANEL_TAB_ID)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  } catch {
    currentTab = null;
  }
  currentOrigin = currentTab ? normalizeOrigin(currentTab.pendingUrl || currentTab.url || "") : null;
}

async function tick() {
  await loadTab(); // tab có thể đã chuyển trang
  await render();
}

tick();
setInterval(tick, 5000);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === PANEL_TAB_ID && info.status === "complete") tick();
});

// ---------------------------------------------------------------------------
// Terminal lịch sử

const FILTERS = {
  all: (e) => e.level !== "debug",
  problems: (e) => e.level === "warn" || e.level === "error",
  debug: () => true,
};
let logFilter = "all";
try {
  logFilter = localStorage.getItem("sk-log-filter") || "all";
} catch {
  /* bỏ qua */
}
$("logFilter").value = FILTERS[logFilter] ? logFilter : "all";

function renderLogs(logs) {
  const term = $("terminal");
  const nearBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
  const shown = logs.filter(FILTERS[$("logFilter").value] || FILTERS.all);

  term.replaceChildren();
  if (!shown.length) {
    const empty = document.createElement("span");
    empty.className = "log-empty";
    empty.textContent = "$ chưa có sự kiện nào";
    term.append(empty);
    return;
  }
  for (const e of shown) {
    const line = document.createElement("div");
    line.className = `log-line log-${e.level}`;
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = formatTime(e.t);
    const level = document.createElement("span");
    level.className = "log-level";
    level.textContent = e.level.toUpperCase();
    const msg = document.createElement("span");
    msg.className = "log-msg";
    msg.textContent = e.msg;
    line.append(time, level, msg);
    term.append(line);
  }
  if (nearBottom) term.scrollTop = term.scrollHeight;
}

async function refreshLogs() {
  renderLogs(await getLogs());
}

$("logFilter").addEventListener("change", () => {
  try {
    localStorage.setItem("sk-log-filter", $("logFilter").value);
  } catch {
    /* bỏ qua */
  }
  refreshLogs();
});

$("copyLogs").addEventListener("click", async () => {
  const logs = (await getLogs()).filter(FILTERS[$("logFilter").value] || FILTERS.all);
  try {
    await navigator.clipboard.writeText(logs.map(formatLine).join("\n"));
    $("copyLogs").textContent = "Đã chép";
  } catch {
    $("copyLogs").textContent = "Lỗi chép";
  }
  setTimeout(() => ($("copyLogs").textContent = "Sao chép"), 1500);
});

$("clearLogs").addEventListener("click", async () => {
  await clearLogs();
  await refreshLogs();
});

// Cập nhật ngay khi background ghi log mới.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[LOG_KEY]) renderLogs(changes[LOG_KEY].newValue || []);
});

refreshLogs().then(() => {
  $("terminal").scrollTop = $("terminal").scrollHeight;
});
