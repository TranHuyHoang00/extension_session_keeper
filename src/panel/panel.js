import { getSiteSettings, saveSiteSettings, hostOf } from "../config.js";
import { getExp } from "../jwt.js";
import { LOG_KEY, getLogs, clearLogs, formatTime, formatLine, log } from "../log.js";

const STATUS_LABEL = {
  unbound: "Chưa gắn",
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
const show = (el, visible) => (el.hidden = !visible);

// Side panel được mở riêng cho một tab; tabId nằm trong URL của panel.
const TAB_ID = Number(new URLSearchParams(location.search).get("tabId"));
let info = null; // kết quả getStatus gần nhất

function fmt(ms) {
  if (!ms) return "–";
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const rel =
    abs < 60_000
      ? "vài giây"
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)} phút`
        : `${(abs / 3_600_000).toFixed(1)} giờ`;
  return `${new Date(ms).toLocaleString("vi-VN")} (${diff >= 0 ? "còn " + rel : rel + " trước"})`;
}

async function send(type) {
  const res = await chrome.runtime.sendMessage({ type, tabId: TAB_ID });
  if (!res?.ok) throw new Error(res?.error || "Không có phản hồi");
  return res.result;
}

// ---------------------------------------------------------------------------
// Màn hình chính

async function render() {
  info = await send("getStatus");
  const { binding, state, settings, tabOrigin, settingsOrigin, boundElsewhere, bound } = info;
  const host = settingsOrigin ? hostOf(settingsOrigin) : "";
  const status = binding ? state.status : "unbound";

  $("siteLabel").textContent = host || "Trang không hỗ trợ";
  $("status").textContent = STATUS_LABEL[status] || status;
  $("status").dataset.status = status;
  $("message").textContent = binding ? state.message || "" : "";

  // Khu vực gắn tab
  if (binding) {
    $("bindText").textContent = `Đang giữ phiên cho ${host} ở tab này.`;
  } else if (boundElsewhere) {
    $("bindText").textContent = `${host} đang được giữ ở tab #${boundElsewhere.tabId}. Mỗi website chỉ giữ ở một tab.`;
  } else if (tabOrigin) {
    $("bindText").textContent = `Gắn tab này để giữ phiên đăng nhập cho ${host}.`;
  } else {
    $("bindText").textContent = "Trang này không phải https nên không gắn được. Hãy mở website cần giữ phiên.";
  }
  show($("bind"), !binding && !!tabOrigin);
  $("bind").textContent = boundElsewhere ? "Chuyển sang tab này" : "Gắn vào tab này";
  show($("unbind"), !!binding);
  show($("goto"), !binding && !!boundElsewhere);

  // Thông tin chi tiết chỉ có khi tab này đã gắn
  show($("facts"), !!binding);
  if (binding) {
    $("cookieName").textContent = settings.tokenCookie;
    $("exp").textContent = state.exp ? fmt(state.exp * 1000) : "–";
    $("next").textContent = fmt(state.nextRefreshAt);
    $("last").textContent = fmt(state.lastSuccessAt);
    $("fails").textContent = String(state.failCount);
  }
  show($("refresh"), !!binding);
  show($("reset"), !!binding);
  $("refresh").disabled = !binding || !settings.enabled || state.status === "refreshing";
  show($("openSettings"), !!settingsOrigin);

  // Các website đang được giữ
  const others = bound.filter((b) => b.tabId !== TAB_ID);
  $("boundList").textContent = others.length
    ? `Đang giữ thêm: ${others.map((b) => `${b.site} (tab #${b.tabId})`).join(", ")}.`
    : "";

  await refreshLogs();
}

async function act(type) {
  try {
    await send(type);
    await render();
  } catch (err) {
    const msg = err.message || String(err);
    await log("error", msg, { tabId: TAB_ID, site: info?.settingsOrigin ? hostOf(info.settingsOrigin) : undefined });
    await render().catch(() => {});
    $("message").textContent = msg;
  }
}

$("bind").addEventListener("click", () => {
  const origin = info?.tabOrigin;
  if (!origin) return;
  // permissions.request phải gọi ngay trong lần bấm của người dùng.
  chrome.permissions.request({ origins: [origin + "/*"] }, (granted) => {
    if (!granted) {
      $("message").textContent = "Bạn chưa cấp quyền cho website này nên không thể gắn.";
      return;
    }
    act("bind");
  });
});
$("unbind").addEventListener("click", () => act("unbind"));
$("goto").addEventListener("click", async () => {
  const id = info?.boundElsewhere?.tabId;
  if (id == null) return;
  const tab = await chrome.tabs.update(id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
});
$("refresh").addEventListener("click", () => act("refreshNow"));
$("reset").addEventListener("click", () => act("reset"));

// ---------------------------------------------------------------------------
// Cài đặt theo website, ngay trong panel

const showSettingsResult = (text, kind = "") => {
  $("settingsResult").textContent = text;
  $("settingsResult").dataset.kind = kind;
};

async function openSettings() {
  const origin = info?.settingsOrigin;
  if (!origin) return;
  const s = await getSiteSettings(origin);
  $("settingsTitle").textContent = `Cài đặt cho ${hostOf(origin)}`;
  $("tokenCookie").value = s.tokenCookie;
  $("marginSec").value = s.marginSec;
  $("enabled").checked = s.enabled;
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
  const origin = info?.settingsOrigin;
  if (!origin) return;
  await saveSiteSettings(origin, {
    tokenCookie: $("tokenCookie").value.trim(),
    marginSec: Math.max(60, Number($("marginSec").value) || 180),
    enabled: $("enabled").checked,
  });
  showSettingsResult(`Đã lưu cài đặt cho ${hostOf(origin)}.`, "ok");
});

$("checkCookie").addEventListener("click", async () => {
  const origin = info?.settingsOrigin;
  const name = $("tokenCookie").value.trim();
  if (!origin) return showSettingsResult("Trang này không phải https.", "error");
  if (!name) return showSettingsResult("Nhập tên cookie trước.", "error");
  if (!(await chrome.permissions.contains({ origins: [origin + "/*"] }))) {
    return showSettingsResult('Chưa có quyền với website này. Quay lại và bấm "Gắn vào tab này" trước.', "error");
  }
  const cookie = await chrome.cookies.get({ url: origin, name });
  if (!cookie) return showSettingsResult(`Không tìm thấy cookie "${name}" trên ${hostOf(origin)}. Bạn đã đăng nhập chưa?`, "error");
  const exp = getExp(cookie.value);
  if (!exp) return showSettingsResult(`Cookie "${name}" không phải JWT hoặc không có trường exp.`, "error");
  showSettingsResult(`Tìm thấy token. Hết hạn lúc ${new Date(exp * 1000).toLocaleString("vi-VN")}.`, "ok");
});

// ---------------------------------------------------------------------------
// Terminal lịch sử

const LEVEL_FILTERS = {
  all: (e) => e.level !== "debug",
  problems: (e) => e.level === "warn" || e.level === "error",
  debug: () => true,
};

const pref = {
  get(k, d) {
    try {
      return localStorage.getItem(k) || d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* bỏ qua */
    }
  },
};
$("logFilter").value = LEVEL_FILTERS[pref.get("sk-log-filter", "all")] ? pref.get("sk-log-filter", "all") : "all";
$("logScope").value = pref.get("sk-log-scope", "site") === "all" ? "all" : "site";

function visibleLogs(logs) {
  const levelOk = LEVEL_FILTERS[$("logFilter").value] || LEVEL_FILTERS.all;
  const host = info?.settingsOrigin ? hostOf(info.settingsOrigin) : null;
  const siteScope = $("logScope").value === "site";
  // "Website này": log của website này + log chung (không gắn website nào).
  return logs.filter((e) => levelOk(e) && (!siteScope || !e.site || e.site === host));
}

function renderLogs(logs) {
  const term = $("terminal");
  const nearBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
  const shown = visibleLogs(logs);
  const showSite = $("logScope").value === "all";

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
    if (showSite && e.site) {
      const site = document.createElement("span");
      site.className = "log-site";
      site.textContent = `[${e.site}] `;
      msg.append(site);
    }
    msg.append(e.msg);
    line.append(time, level, msg);
    term.append(line);
  }
  if (nearBottom) term.scrollTop = term.scrollHeight;
}

async function refreshLogs() {
  renderLogs(await getLogs());
}

for (const id of ["logFilter", "logScope"]) {
  $(id).addEventListener("change", () => {
    pref.set(id === "logFilter" ? "sk-log-filter" : "sk-log-scope", $(id).value);
    refreshLogs();
  });
}

$("copyLogs").addEventListener("click", async () => {
  const lines = visibleLogs(await getLogs()).map(formatLine).join("\n");
  try {
    await navigator.clipboard.writeText(lines);
    $("copyLogs").textContent = "Đã chép";
  } catch {
    $("copyLogs").textContent = "Lỗi";
  }
  setTimeout(() => ($("copyLogs").textContent = "Chép"), 1500);
});

$("clearLogs").addEventListener("click", async () => {
  await clearLogs();
  await refreshLogs();
});

// Cập nhật ngay khi background ghi log mới hoặc trạng thái đổi.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[LOG_KEY]) renderLogs(changes[LOG_KEY].newValue || []);
  if (changes.states || changes.bindings) tick();
});

// ---------------------------------------------------------------------------

let ticking = false;
async function tick() {
  if (ticking || !$("settingsView").hidden) return;
  ticking = true;
  try {
    await render();
  } catch (err) {
    $("message").textContent = err.message || String(err);
  } finally {
    ticking = false;
  }
}

tick().then(() => ($("terminal").scrollTop = $("terminal").scrollHeight));
setInterval(tick, 5000);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === TAB_ID && changeInfo.status === "complete") tick();
});
