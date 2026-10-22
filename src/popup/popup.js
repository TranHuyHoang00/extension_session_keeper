const STATUS_LABEL = {
  idle: "Chưa hoạt động",
  scheduled: "Đang theo dõi",
  ok: "Ổn định",
  refreshing: "Đang làm mới",
  logged_out: "Chưa đăng nhập",
  needs_attention: "Cần xử lý",
  stopped: "Đã dừng",
  error: "Lỗi cấu hình",
};

const $ = (id) => document.getElementById(id);

function fmt(ms) {
  if (!ms) return "–";
  const d = new Date(ms);
  const diff = ms - Date.now();
  const rel =
    Math.abs(diff) < 60_000
      ? "vài giây"
      : Math.abs(diff) < 3_600_000
        ? `${Math.round(Math.abs(diff) / 60_000)} phút`
        : `${(Math.abs(diff) / 3_600_000).toFixed(1)} giờ`;
  return `${d.toLocaleString("vi-VN")} (${diff >= 0 ? "còn " + rel : rel + " trước"})`;
}

async function send(type) {
  const res = await chrome.runtime.sendMessage({ type });
  if (!res?.ok) throw new Error(res?.error || "Không có phản hồi");
  return res.result;
}

async function render() {
  const { state, config } = await send("getStatus");
  $("status").textContent = STATUS_LABEL[state.status] || state.status;
  $("status").dataset.status = state.status;
  $("message").textContent = state.message || "";
  $("site").textContent = config.siteUrl || "Chưa cấu hình";
  $("exp").textContent = state.exp ? fmt(state.exp * 1000) : "–";
  $("next").textContent = fmt(state.nextRefreshAt);
  $("last").textContent = fmt(state.lastSuccessAt);
  $("fails").textContent = String(state.failCount);
  $("refresh").disabled = !config.siteUrl || !config.enabled || state.status === "refreshing";
}

async function act(type) {
  try {
    await send(type);
  } catch (err) {
    $("message").textContent = String(err.message || err);
  }
  await render();
}

$("refresh").addEventListener("click", () => act("refreshNow"));
$("reset").addEventListener("click", () => act("reset"));
$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

render();
setInterval(render, 5000);
