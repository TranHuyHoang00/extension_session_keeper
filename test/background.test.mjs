import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createChromeMock, makeJwt } from "./chrome-mock.mjs";

const mock = createChromeMock();
globalThis.chrome = mock.chrome;
const { __test__: bg } = await import("../src/background.js");
const { getExp } = await import("../src/jwt.js");
const cfgMod = await import("../src/config.js");
const logMod = await import("../src/log.js");

// Hai website khác nhau, mỗi website một tên cookie riêng.
const A = "https://a.example.com";
const B = "https://b.other.vn";
const TAB_A = 2;
const TAB_B = 5;

const db = mock.db;
const nowSec = () => Math.floor(Date.now() / 1000);
const st = (tabId) => db.local.states?.[String(tabId)];
const setToken = (origin, name, exp) => {
  db.cookies[origin] = { ...(db.cookies[origin] || {}), [name]: makeJwt({ exp }) };
};
const alarm = (kind, tabId) => db.alarms[`sk-${kind}:${tabId}`];
const logsText = () => (db.local.logs || []).map((l) => `${l.level} [${l.site || "-"}] ${l.msg}`).join("\n");

beforeEach(() => {
  db.sync = {
    sites: {
      // A: website chỉ refresh khi API báo lỗi → reload SAU khi hết hạn (mặc định)
      [A]: { tokenCookie: "privateToken", timing: "after", afterSec: 10, enabled: true },
      // B: website tự refresh khi tải trang → reload TRƯỚC khi hết hạn
      [B]: { tokenCookie: "access_token", timing: "before", marginSec: 300, enabled: true },
    },
  };
  db.local = {
    bindings: {
      [TAB_A]: { tabId: TAB_A, origin: A },
      [TAB_B]: { tabId: TAB_B, origin: B },
    },
    states: {},
    logs: [],
  };
  db.cookies = {};
  db.alarms = {};
  db.tabs = [
    { id: 1, url: A + "/khac", active: false, windowId: 1 },
    { id: TAB_A, url: A + "/dashboard", active: true, windowId: 1 },
    { id: TAB_B, url: B + "/home", active: false, windowId: 1 },
  ];
  db.created = [];
  db.reloaded = [];
  db.removedTabs = [];
  db.notifications = [];
  db.tabBadges = {};
  db.pageState = { captcha: false, login: false, path: "/" };
  db.granted = true;
  db.panelOptions = [];
  db.panelOpened = [];
});

// ---------------------------------------------------------------------------
// Tiện ích

test("đọc exp từ JWT", () => {
  assert.equal(getExp(makeJwt({ exp: 1792722565, sub: "Tiếng Việt ~~~???" })), 1792722565);
  assert.equal(getExp("waryzZQpOHLDhGf7Z4sDX_XYtauKXX3mB5UreNmL1"), null);
  assert.equal(getExp("a.b.c"), null);
});

test("khớp domain cookie và tên alarm", () => {
  assert.ok(bg.cookieDomainMatches(".example.com", "a.example.com"));
  assert.ok(!bg.cookieDomainMatches("ample.com", "a.example.com"));
  assert.deepEqual(bg.parseAlarm("sk-refresh:12"), { kind: "sk-refresh", tabId: 12 });
  assert.equal(bg.parseAlarm("lạ"), null);
});

// ---------------------------------------------------------------------------
// Nhiều website chạy độc lập

test("hai website: mỗi tab lịch riêng theo đúng tên cookie và cách làm mới riêng", async () => {
  const expA = nowSec() + 3600;
  const expB = nowSec() + 7200;
  setToken(A, "privateToken", expA);
  setToken(B, "access_token", expB);
  // Cookie trùng tên nhưng sai website thì không được tính
  setToken(B, "privateToken", nowSec() + 10);

  await bg.scheduleAll();
  assert.equal(st(TAB_A).status, "scheduled");
  assert.equal(st(TAB_B).status, "scheduled");
  assert.equal(alarm("refresh", TAB_A), (expA + 10) * 1000); // sau khi hết hạn
  assert.equal(alarm("refresh", TAB_B), (expB - 300) * 1000); // trước khi hết hạn
  assert.equal(db.tabBadges[TAB_A], "ON");
  assert.equal(db.tabBadges[TAB_B], "ON");
  assert.equal(db.tabBadges[1], undefined);
});

test("website B dùng tên cookie khác: không thấy cookie của A thì báo đúng tên", async () => {
  setToken(A, "privateToken", nowSec() + 3600);
  await bg.schedule(TAB_B);
  assert.equal(st(TAB_B).status, "logged_out");
  assert.match(st(TAB_B).message, /access_token/);
  assert.equal(db.notifications.at(-1).title, "Session Keeper – b.other.vn");
});

test("làm mới tab A không đụng tới tab B", async () => {
  setToken(A, "privateToken", nowSec() + 60);
  setToken(B, "access_token", nowSec() + 7200);
  await bg.scheduleAll();
  const alarmB = alarm("refresh", TAB_B);

  await bg.startRefresh(TAB_A);
  assert.deepEqual(db.reloaded, [TAB_A]);
  assert.equal(st(TAB_A).status, "refreshing");
  assert.ok(alarm("verify", TAB_A));
  assert.equal(st(TAB_B).status, "scheduled");
  assert.equal(alarm("refresh", TAB_B), alarmB);
  assert.equal(alarm("verify", TAB_B), undefined);

  const newExp = nowSec() + 86400;
  setToken(A, "privateToken", newExp);
  await bg.onTokenCookieChanged(TAB_A);
  assert.equal(st(TAB_A).status, "scheduled");
  assert.equal(st(TAB_A).exp, newExp);
  assert.ok(st(TAB_A).lastSuccessAt);
  assert.equal(st(TAB_B).lastSuccessAt, null);
});

test("lỗi ở website A (CAPTCHA) không làm dừng website B", async () => {
  setToken(A, "privateToken", nowSec() + 60);
  setToken(B, "access_token", nowSec() + 7200);
  await bg.scheduleAll();
  await bg.startRefresh(TAB_A);
  db.pageState = { captcha: true, login: false, path: "/" };
  await bg.verifyRefresh(TAB_A);

  assert.equal(st(TAB_A).status, "needs_attention");
  assert.equal(alarm("refresh", TAB_A), undefined);
  assert.equal(st(TAB_B).status, "scheduled");
  assert.ok(alarm("refresh", TAB_B));
  assert.equal(db.notifications.at(-1).id, `sk-alert:${TAB_A}`);
});

// ---------------------------------------------------------------------------
// Gắn / bỏ gắn

test("gắn website mới thứ ba vẫn giữ hai website cũ", async () => {
  const C = "https://c.site.io";
  db.tabs.push({ id: 9, url: C + "/", active: false, windowId: 1 });
  setToken(C, "privateToken", nowSec() + 3600);
  await bg.bindTab(9);
  const bindings = db.local.bindings;
  assert.deepEqual(Object.keys(bindings).sort(), ["2", "5", "9"]);
  assert.equal(st(9).status, "scheduled");
});

test("mỗi website chỉ một tab: gắn tab khác cùng website thì chuyển sang tab mới", async () => {
  setToken(A, "privateToken", nowSec() + 3600);
  await bg.bindTab(1);
  assert.equal(db.local.bindings[TAB_A], undefined);
  assert.deepEqual(db.local.bindings[1], { tabId: 1, origin: A });
  assert.equal(db.local.bindings[TAB_B].origin, B);
  assert.match(logsText(), /chuyển sang giữ ở tab #1/);
});

test("không gắn được trang không phải https", async () => {
  db.tabs.push({ id: 9, url: "chrome://newtab/", active: true, windowId: 1 });
  await assert.rejects(() => bg.bindTab(9), /https/);
});

test("đóng tab A chỉ bỏ gắn A", async () => {
  setToken(A, "privateToken", nowSec() + 60);
  db.tabs = db.tabs.filter((t) => t.id !== TAB_A);
  await bg.startRefresh(TAB_A);
  assert.deepEqual(db.reloaded, []);
  assert.deepEqual(db.created, []);
  assert.equal(db.local.bindings[TAB_A], undefined);
  assert.ok(db.local.bindings[TAB_B]);
});

test("tab A chuyển sang website khác → không reload, chờ quay lại", async () => {
  setToken(A, "privateToken", nowSec() + 60);
  db.tabs.find((t) => t.id === TAB_A).url = "https://google.com/";
  await bg.startRefresh(TAB_A);
  assert.deepEqual(db.reloaded, []);
  assert.equal(st(TAB_A).status, "needs_attention");
  assert.ok(alarm("refresh", TAB_A) > Date.now());
});

test("trình duyệt khởi động lại → bỏ gắn tất cả, báo một lần", async () => {
  db.alarms["sk-refresh:2"] = 1;
  await bg.onBrowserStartup();
  assert.deepEqual(db.local.bindings, {});
  assert.deepEqual(db.alarms, {});
  assert.equal(db.notifications.length, 1);
  assert.match(db.notifications[0].message, /2 tab/);
});

test("bỏ gắn → xoá lịch, trạng thái và badge của đúng tab", async () => {
  setToken(A, "privateToken", nowSec() + 3600);
  setToken(B, "access_token", nowSec() + 3600);
  await bg.scheduleAll();
  await bg.unbind(TAB_A, "Đã bỏ gắn tab.");
  assert.equal(db.local.bindings[TAB_A], undefined);
  assert.equal(st(TAB_A), undefined);
  assert.equal(alarm("refresh", TAB_A), undefined);
  assert.equal(db.tabBadges[TAB_A], "");
  assert.ok(alarm("refresh", TAB_B));
});

// ---------------------------------------------------------------------------
// Thử lại / dừng

test("không reload lại khi lần thử trước còn quá gần", async () => {
  setToken(A, "privateToken", nowSec() + 60);
  db.local.states[TAB_A] = { lastAttemptAt: Date.now() - 10_000 };
  await bg.startRefresh(TAB_A);
  assert.deepEqual(db.reloaded, []);
  assert.ok(alarm("refresh", TAB_A) > Date.now());
});

test("gặp trang đăng nhập → báo cần đăng nhập lại", async () => {
  setToken(A, "privateToken", nowSec() + 60);
  await bg.startRefresh(TAB_A);
  db.pageState = { captcha: false, login: true, path: "/login" };
  await bg.verifyRefresh(TAB_A);
  assert.equal(st(TAB_A).status, "needs_attention");
  assert.match(st(TAB_A).message, /đăng nhập lại/);
});

test("thất bại không rõ lý do → thử lại, quá số lần thì dừng", async () => {
  setToken(A, "privateToken", nowSec() + 60);
  for (let i = 1; i <= 3; i++) {
    db.local.states[TAB_A] = { ...st(TAB_A), lastAttemptAt: null };
    await bg.startRefresh(TAB_A);
    await bg.verifyRefresh(TAB_A);
    assert.equal(st(TAB_A).failCount, i);
  }
  assert.equal(st(TAB_A).status, "stopped");
  const before = db.reloaded.length;
  await bg.startRefresh(TAB_A);
  assert.equal(db.reloaded.length, before);
});

test("đăng nhập lại sau khi dừng → hoạt động trở lại", async () => {
  db.local.states[TAB_A] = { status: "stopped", failCount: 3, exp: nowSec() + 60 };
  setToken(A, "privateToken", nowSec() + 86400);
  await bg.onTokenCookieChanged(TAB_A);
  assert.equal(st(TAB_A).status, "scheduled");
  assert.equal(st(TAB_A).failCount, 0);
});

// ---------------------------------------------------------------------------
// Dữ liệu cũ, side panel, trạng thái cho panel

test("chuyển dữ liệu phiên bản cũ (1 tab) sang dạng nhiều tab", async () => {
  db.sync = { config: { tokenCookie: "myToken", marginSec: 600, enabled: true } };
  db.local = { binding: { tabId: 7, origin: A }, state: { status: "scheduled", failCount: 1 } };
  assert.equal(await cfgMod.migrateLegacy(), true);
  assert.deepEqual(db.local.bindings, { 7: { tabId: 7, origin: A } });
  assert.equal(db.local.states["7"].failCount, 1);
  assert.equal(db.sync.sites[A].tokenCookie, "myToken");
  assert.equal(db.sync.sites[A].marginSec, 600);
  assert.ok(!("binding" in db.local) && !("config" in db.sync));
});

test("trạng thái cho side panel: biết website đang giữ ở tab khác", async () => {
  const s = await bg.getStatusFor(1); // tab 1 cùng website A, chưa gắn
  assert.equal(s.binding, null);
  assert.equal(s.tabOrigin, A);
  assert.deepEqual(s.boundElsewhere, { tabId: TAB_A, origin: A });
  assert.equal(s.settings.tokenCookie, "privateToken");
  assert.equal(s.bound.length, 2);
});

test("side panel: tắt mặc định, chỉ bật cho tab được bấm icon", async () => {
  await bg.disablePanelGlobally();
  assert.deepEqual(db.panelOptions.at(-1), { enabled: false });
  bg.openPanelForTab({ id: 3 });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(db.panelOptions.at(-1), { tabId: 3, path: "src/panel/panel.html?tabId=3", enabled: true });
  assert.deepEqual(db.panelOpened, [3]);
});

// ---------------------------------------------------------------------------
// Log

test("log ghi kèm website, không chứa token", async () => {
  setToken(A, "privateToken", nowSec() + 60);
  setToken(B, "access_token", nowSec() + 7200);
  const tokenA = db.cookies[A].privateToken;
  await bg.scheduleAll();
  await bg.startRefresh(TAB_A, { manual: true });
  setToken(A, "privateToken", nowSec() + 86400);
  await bg.onTokenCookieChanged(TAB_A);

  const text = logsText();
  assert.match(text, /info \[a\.example\.com\] Reload tab #2/);
  assert.match(text, /success \[a\.example\.com\] Đã có token mới/);
  assert.match(text, /info \[b\.other\.vn\] Token hết hạn lúc/);
  assert.ok(!/\[b\.other\.vn\] Reload/.test(text));
  for (const t of [tokenA, db.cookies[A].privateToken]) assert.ok(!text.includes(t.split(".")[1]));
});

test("log không ghi trùng khi gọi lại schedule", async () => {
  setToken(A, "privateToken", nowSec() + 60);
  await bg.startRefresh(TAB_A);
  db.pageState = { captcha: true, login: false, path: "/" };
  await bg.verifyRefresh(TAB_A);
  await bg.schedule(TAB_A);
  const n = db.local.logs.filter((l) => /yêu cầu xác minh/.test(l.msg)).length;
  assert.equal(n, 1);
});

test("log giới hạn số dòng lưu trữ", async () => {
  await Promise.all(
    Array.from({ length: logMod.MAX_LOGS + 25 }, (_, i) => logMod.log("info", `dòng ${i}`))
  );
  const logs = await logMod.getLogs();
  assert.equal(logs.length, logMod.MAX_LOGS);
  assert.equal(logs.at(-1).msg, `dòng ${logMod.MAX_LOGS + 24}`);
});

// ---------------------------------------------------------------------------
// Thời điểm làm mới

test("thời điểm làm mới: mặc định SAU khi hết hạn", () => {
  const site = cfgMod.DEFAULT_SITE;
  assert.equal(site.timing, "after");
  assert.equal(cfgMod.refreshTargetMs(1000, site), (1000 + site.afterSec) * 1000);
  assert.equal(cfgMod.refreshTargetMs(1000, { ...site, timing: "before", marginSec: 60 }), 940_000);
});

test("website cũ chưa có timing → dùng kiểu sau khi hết hạn", async () => {
  db.sync.sites[A] = { tokenCookie: "privateToken", marginSec: 180, enabled: true };
  const exp = nowSec() + 600;
  setToken(A, "privateToken", exp);
  await bg.schedule(TAB_A);
  assert.equal(alarm("refresh", TAB_A), (exp + 10) * 1000);
});

test("token hết hạn và cookie bị xoá (kiểu after) → vẫn reload, không coi là đăng xuất", async () => {
  const exp = nowSec() + 60;
  setToken(A, "privateToken", exp);
  await bg.schedule(TAB_A);
  // Trình duyệt xoá cookie đúng lúc token hết hạn
  db.local.states[TAB_A].exp = nowSec() - 1;
  delete db.cookies[A].privateToken;
  await bg.onTokenCookieChanged(TAB_A);

  assert.equal(st(TAB_A).status, "scheduled");
  assert.match(st(TAB_A).message, /Token đã hết hạn/);
  assert.ok(alarm("refresh", TAB_A) <= Date.now() + 31_000);
  assert.equal(db.notifications.length, 0);

  // Đến giờ: reload, website gọi API lỗi rồi tự refresh → có cookie mới
  await bg.startRefresh(TAB_A);
  assert.deepEqual(db.reloaded, [TAB_A]);
  setToken(A, "privateToken", nowSec() + 86400);
  await bg.onTokenCookieChanged(TAB_A);
  assert.equal(st(TAB_A).status, "scheduled");
  assert.ok(st(TAB_A).lastSuccessAt);
});

test("cookie bị xoá khi token CÒN hạn → báo chưa đăng nhập", async () => {
  setToken(A, "privateToken", nowSec() + 3600);
  await bg.schedule(TAB_A);
  delete db.cookies[A].privateToken;
  await bg.onTokenCookieChanged(TAB_A);
  assert.equal(st(TAB_A).status, "logged_out");
});

// ---------------------------------------------------------------------------
// Bấm icon = gắn luôn

test("bấm icon trên website chưa gắn → mở panel và gắn ngay", async () => {
  const C = "https://c.site.io";
  db.tabs.push({ id: 9, url: C + "/", active: true, windowId: 1 });
  setToken(C, "privateToken", nowSec() + 3600);
  await bg.openPanelForTab({ id: 9 });
  assert.deepEqual(db.panelOpened, [9]);
  assert.deepEqual(db.local.bindings[9], { tabId: 9, origin: C });
  assert.equal(st(9).status, "scheduled");
});

test("bấm icon lại trên tab đã gắn → không đặt lại trạng thái", async () => {
  setToken(A, "privateToken", nowSec() + 3600);
  db.local.states[TAB_A] = { status: "scheduled", failCount: 2, lastSuccessAt: 123 };
  await bg.openPanelForTab({ id: TAB_A });
  assert.equal(st(TAB_A).failCount, 2);
  assert.equal(st(TAB_A).lastSuccessAt, 123);
});

test("bấm icon trên trang không phải https → chỉ mở panel, không gắn", async () => {
  db.tabs.push({ id: 9, url: "chrome://extensions/", active: true, windowId: 1 });
  await bg.openPanelForTab({ id: 9 });
  assert.deepEqual(db.panelOpened, [9]);
  assert.equal(db.local.bindings[9], undefined);
});
