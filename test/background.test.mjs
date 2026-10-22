import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createChromeMock, makeJwt } from "./chrome-mock.mjs";

const mock = createChromeMock();
globalThis.chrome = mock.chrome;
const { __test__: bg } = await import("../src/background.js");
const { getExp } = await import("../src/jwt.js");
const { DEFAULT_STATE } = await import("../src/config.js");

const SITE = "https://app.example.com";
const nowSec = () => Math.floor(Date.now() / 1000);
const db = mock.db;
const state = () => db.local.state;

// Mặc định: 3 tab cùng website, tab 2 được gắn.
beforeEach(() => {
  db.sync = { config: { tokenCookie: "access_token" } };
  db.local = { state: { ...DEFAULT_STATE }, binding: { tabId: 2, origin: SITE } };
  db.cookies = {};
  db.alarms = {};
  db.tabs = [
    { id: 1, url: SITE + "/a", active: false, windowId: 1 },
    { id: 2, url: SITE + "/b", active: true, windowId: 1 },
    { id: 3, url: SITE + "/c", active: false, windowId: 1 },
  ];
  db.created = [];
  db.reloaded = [];
  db.removedTabs = [];
  db.notifications = [];
  db.tabBadges = {};
  db.pageState = { captcha: false, login: false, path: "/" };
  db.granted = true;
});

test("đọc exp từ JWT", () => {
  assert.equal(getExp(makeJwt({ exp: 1792722565, sub: "Tiếng Việt ~~~???" })), 1792722565);
  assert.equal(getExp("waryzZQpOHLDhGf7Z4sDX_XYtauKXX3mB5UreNmL1"), null);
  assert.equal(getExp("a.b.c"), null);
});

test("khớp domain cookie", () => {
  assert.ok(bg.cookieDomainMatches(".example.com", "app.example.com"));
  assert.ok(bg.cookieDomainMatches("app.example.com", "app.example.com"));
  assert.ok(!bg.cookieDomainMatches("evil.com", "app.example.com"));
  assert.ok(!bg.cookieDomainMatches("ample.com", "app.example.com"));
});

test("chưa gắn tab → không làm gì", async () => {
  db.local.binding = null;
  db.cookies.access_token = makeJwt({ exp: nowSec() + 3600 });
  await bg.schedule();
  assert.equal(state().status, "unbound");
  assert.deepEqual(db.alarms, {});
  await bg.startRefresh();
  assert.deepEqual(db.reloaded, []);
});

test("gắn tab → lên lịch trước exp đúng margin, badge chỉ trên tab gắn", async () => {
  db.local.binding = null;
  const exp = nowSec() + 3600;
  db.cookies.access_token = makeJwt({ exp });
  await bg.bindTab(3);
  assert.deepEqual(db.local.binding, { tabId: 3, origin: SITE });
  assert.equal(state().status, "scheduled");
  assert.equal(db.alarms["sk-refresh"], (exp - 180) * 1000);
  assert.equal(db.badge, "");
  assert.equal(db.tabBadges[3], "ON");
  assert.equal(db.tabBadges[1], undefined);
});

test("không gắn được trang không phải https", async () => {
  db.tabs.push({ id: 9, url: "chrome://newtab/", active: true, windowId: 1 });
  await assert.rejects(() => bg.bindTab(9), /https/);
});

test("chỉ reload ĐÚNG tab đã gắn, không mở tab mới", async () => {
  db.cookies.access_token = makeJwt({ exp: nowSec() + 60 });
  await bg.startRefresh();
  assert.deepEqual(db.reloaded, [2]);
  assert.deepEqual(db.created, []);
  assert.equal(state().status, "refreshing");

  const newExp = nowSec() + 86400;
  db.cookies.access_token = makeJwt({ exp: newExp });
  await bg.onTokenCookieChanged();
  assert.equal(state().status, "scheduled");
  assert.equal(state().exp, newExp);
  assert.equal(state().failCount, 0);
  assert.ok(state().lastSuccessAt);
  assert.ok(!("sk-verify" in db.alarms));
  assert.deepEqual(db.removedTabs, []);
});

test("tab đã gắn bị đóng → ngừng và báo, không mở tab khác", async () => {
  db.cookies.access_token = makeJwt({ exp: nowSec() + 60 });
  db.tabs = db.tabs.filter((t) => t.id !== 2);
  await bg.startRefresh();
  assert.deepEqual(db.reloaded, []);
  assert.deepEqual(db.created, []);
  assert.equal(db.local.binding, null);
  assert.equal(state().status, "unbound");
  assert.match(db.notifications.at(-1), /gắn lại/);
  assert.deepEqual(db.alarms, {});
});

test("tab đã gắn chuyển sang website khác → không reload, chờ quay lại", async () => {
  db.cookies.access_token = makeJwt({ exp: nowSec() + 60 });
  db.tabs.find((t) => t.id === 2).url = "https://google.com/";
  await bg.startRefresh();
  assert.deepEqual(db.reloaded, []);
  assert.equal(state().status, "needs_attention");
  assert.ok(db.alarms["sk-refresh"] > Date.now());
});

test("trình duyệt khởi động lại → bỏ gắn (tabId cũ không còn đúng)", async () => {
  await bg.onBrowserStartup();
  assert.equal(db.local.binding, null);
  assert.equal(state().status, "unbound");
  assert.match(db.notifications.at(-1), /khởi động lại/);
});

test("bỏ gắn → xoá lịch và badge", async () => {
  db.cookies.access_token = makeJwt({ exp: nowSec() + 3600 });
  await bg.schedule();
  await bg.unbind("Đã bỏ gắn tab.");
  assert.equal(db.local.binding, null);
  assert.deepEqual(db.alarms, {});
  assert.equal(db.tabBadges[2], "");
});

test("không reload lại khi lần thử trước còn quá gần", async () => {
  db.cookies.access_token = makeJwt({ exp: nowSec() + 60 });
  db.local.state.lastAttemptAt = Date.now() - 10_000;
  await bg.startRefresh();
  assert.deepEqual(db.reloaded, []);
  assert.ok(db.alarms["sk-refresh"] > Date.now());
});

test("gặp CAPTCHA → dừng tự động và báo người dùng", async () => {
  db.cookies.access_token = makeJwt({ exp: nowSec() + 60 });
  await bg.startRefresh();
  db.pageState = { captcha: true, login: false, path: "/" };
  await bg.verifyRefresh();
  assert.equal(state().status, "needs_attention");
  assert.match(db.notifications.at(-1), /CAPTCHA/);
  assert.ok(!("sk-refresh" in db.alarms));
});

test("gặp trang đăng nhập → báo cần đăng nhập lại", async () => {
  db.cookies.access_token = makeJwt({ exp: nowSec() + 60 });
  await bg.startRefresh();
  db.pageState = { captcha: false, login: true, path: "/login" };
  await bg.verifyRefresh();
  assert.equal(state().status, "needs_attention");
  assert.match(state().message, /đăng nhập lại/);
});

test("thất bại không rõ lý do → thử lại, quá số lần thì dừng", async () => {
  db.cookies.access_token = makeJwt({ exp: nowSec() + 60 });
  for (let i = 1; i <= 3; i++) {
    db.local.state.lastAttemptAt = null; // bỏ qua khoảng chờ giữa các lần
    await bg.startRefresh();
    await bg.verifyRefresh();
    assert.equal(state().failCount, i);
  }
  assert.equal(state().status, "stopped");
  assert.ok(!("sk-refresh" in db.alarms));

  const before = db.reloaded.length;
  await bg.startRefresh();
  assert.equal(db.reloaded.length, before);
});

test("người dùng đăng nhập lại sau khi bị dừng → hoạt động trở lại", async () => {
  db.local.state = { ...DEFAULT_STATE, status: "stopped", failCount: 3, exp: nowSec() + 60 };
  db.cookies.access_token = makeJwt({ exp: nowSec() + 86400 });
  await bg.onTokenCookieChanged();
  assert.equal(state().status, "scheduled");
  assert.equal(state().failCount, 0);
  assert.ok("sk-refresh" in db.alarms);
});

test("không bao giờ lưu giá trị token vào storage", async () => {
  const token = makeJwt({ exp: nowSec() + 3600 });
  db.cookies.access_token = token;
  await bg.schedule();
  await bg.startRefresh({ manual: true });
  const dump = JSON.stringify({ sync: db.sync, local: db.local });
  assert.ok(!dump.includes(token.split(".")[1]));
});
