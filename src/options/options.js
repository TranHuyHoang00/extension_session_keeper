import { getConfig, saveConfig, normalizeOrigin } from "../config.js";
import { getExp } from "../jwt.js";

const $ = (id) => document.getElementById(id);
const show = (text, kind = "") => {
  $("result").textContent = text;
  $("result").dataset.kind = kind;
};

async function load() {
  const cfg = await getConfig();
  $("siteUrl").value = cfg.siteUrl;
  $("tokenCookie").value = cfg.tokenCookie;
  $("marginSec").value = cfg.marginSec;
  $("enabled").checked = cfg.enabled;
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const origin = normalizeOrigin($("siteUrl").value);
  if (!origin) {
    show("Địa chỉ không hợp lệ. Cần dạng https://ten-mien.", "error");
    return;
  }
  // permissions.request phải được gọi ngay trong thao tác của người dùng.
  chrome.permissions.request({ origins: [origin + "/*"] }, async (granted) => {
    if (!granted) {
      show("Bạn chưa cấp quyền cho website này nên extension không thể hoạt động.", "error");
      return;
    }
    await saveConfig({
      siteUrl: origin,
      tokenCookie: $("tokenCookie").value.trim(),
      marginSec: Math.max(60, Number($("marginSec").value) || 180),
      enabled: $("enabled").checked,
    });
    $("siteUrl").value = origin;
    show("Đã lưu. Extension bắt đầu theo dõi phiên đăng nhập.", "ok");
  });
});

$("check").addEventListener("click", async () => {
  const origin = normalizeOrigin($("siteUrl").value);
  const name = $("tokenCookie").value.trim();
  if (!origin || !name) return show("Nhập địa chỉ website và tên cookie trước.", "error");
  if (!(await chrome.permissions.contains({ origins: [origin + "/*"] }))) {
    return show("Chưa có quyền với website này. Bấm Lưu để cấp quyền trước.", "error");
  }
  const cookie = await chrome.cookies.get({ url: origin, name });
  if (!cookie) return show(`Không tìm thấy cookie "${name}". Bạn đã đăng nhập chưa?`, "error");
  const exp = getExp(cookie.value);
  if (!exp) return show(`Cookie "${name}" không phải JWT hoặc không có trường exp.`, "error");
  show(`Tìm thấy token. Hết hạn lúc ${new Date(exp * 1000).toLocaleString("vi-VN")}.`, "ok");
});

load();
