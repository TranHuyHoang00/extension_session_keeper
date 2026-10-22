import { normalizeOrigin } from "../config.js";

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
  window.close();
});
$("refresh").addEventListener("click", () => act("refreshNow"));
$("reset").addEventListener("click", () => act("reset"));
$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

(async () => {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentOrigin = currentTab ? normalizeOrigin(currentTab.url || "") : null;
  await render();
  setInterval(render, 5000);
})();
