import { getConfig, saveConfig } from "../config.js";
import { getExp } from "../jwt.js";

const $ = (id) => document.getElementById(id);
const show = (text, kind = "") => {
  $("result").textContent = text;
  $("result").dataset.kind = kind;
};

async function load() {
  const cfg = await getConfig();
  $("tokenCookie").value = cfg.tokenCookie;
  $("marginSec").value = cfg.marginSec;
  $("enabled").checked = cfg.enabled;
  $("bound").textContent = cfg.siteUrl
    ? `Đang gắn với một tab của ${cfg.siteUrl}.`
    : "Chưa gắn tab nào.";
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveConfig({
    tokenCookie: $("tokenCookie").value.trim(),
    marginSec: Math.max(60, Number($("marginSec").value) || 180),
    enabled: $("enabled").checked,
  });
  show("Đã lưu.", "ok");
});

$("check").addEventListener("click", async () => {
  const cfg = await getConfig();
  const name = $("tokenCookie").value.trim();
  if (!cfg.siteUrl) return show("Chưa gắn tab nào. Mở website, bấm icon extension và chọn \"Gắn vào tab này\".", "error");
  if (!name) return show("Nhập tên cookie trước.", "error");
  const cookie = await chrome.cookies.get({ url: cfg.siteUrl, name });
  if (!cookie) return show(`Không tìm thấy cookie "${name}" trên ${cfg.siteUrl}. Bạn đã đăng nhập chưa?`, "error");
  const exp = getExp(cookie.value);
  if (!exp) return show(`Cookie "${name}" không phải JWT hoặc không có trường exp.`, "error");
  show(`Tìm thấy token. Hết hạn lúc ${new Date(exp * 1000).toLocaleString("vi-VN")}.`, "ok");
});

load();
