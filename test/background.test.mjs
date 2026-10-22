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

beforeEach(() => {
  db.sync = { config: { siteUrl: SITE, tokenCookie: "access_token" } };
  db.local = { state: { ...DEFAULT_STATE } };
  db.cookies = {};
  db.alarms = {};
  db.tabs = [];
  db.reloaded = [];
  db.removedTabs = [];
  db.notifications = [];
  db.pageState = { captcha: false, login: false, path: "/" };
  db.granted = true;
});

test("đọc exp từ JWT (kể cả payload base64url có ký tự đặc biệt)", () => {
  const token = makeJwt({ exp: 1792722565, sub: "Tiếng Việt ~~~???" });
  assert.equal(getExp(token), 1792722565);
  assert.equal(getExp("waryzZQpOHLDhGf7Z4sDX_XYtauKXX3mB5UreNmL1"), null);
  assert.equal(getExp("a.b.c"), null);
});

test("khớp domain cookie", () => {
  assert.ok(bg.cookieDomainMatches(".example.com", "app.example.com"));
  assert.ok(bg.cookieDomainMatches("app.example.com", "app.example.com"));
  assert.ok(!bg.cookieDomainMatches("evil.com", "app.example.com"));
  assert.ok(!bg.cookieDomainMatches("ample.com", "app.example.com"));
});

test("lên lịch refresh trước exp đúng margin", async () => {
  const exp = nowSec() + 3600;
  db.cookies.access_token = makeJwt({ exp });
  await bg.schedule();
  assert.equal(state().status, "scheduled");
  assert.equal(db.alarms["sk-refresh"], (exp - 180) * 1000);
});

test("không có cookie → báo chưa đăng nhập", async () => {
  await bg.schedule();
  assert.equal(state().status, "logged_out");
  assert.equal(db.notifications.length, 1);
  assert.ok(!("sk-refresh" in db.alarms));
});

test("chưa cấp quyền site → lỗi, không lên lịch", async () => {
  db.granted = false;
  db.cookies.access_token = makeJwt({ exp: nowSec() + 3600 });
  await bg.schedule();
  assert.equal(state().status, "error");
});

test("chỉ reload MỘT tab không active, rồi thành công khi cookie đổi", async () => {
  const oldExp = nowSec() + 60;
  db.cookies.access_token = makeJwt({ exp: oldExp });
  db.tabs.push({ id: 1, url: SITE + "/a", active: true, windowId: 1 });
  db.tabs.push({ id: 2, url: SITE + "/b", active: false, windowId: 1 });
  db.tabs.push({ id: 3, url: SITE + "/c", active: false, windowId: 1 });
  await bg.schedule();
  await bg.startRefresh();

  assert.deepEqual(db.reloaded, [2]);
  assert.equal(state().status, "refreshing");
  assert.ok("sk-verify" in db.alarms);

  // Website tự refresh → cookie mới
  const newExp = nowSec() + 86400;
  db.cookies.access_token = makeJwt({ exp: newExp });
  await bg.onTokenCookieChanged();

  assert.equal(state().status, "scheduled");
  assert.equal(state().exp, newExp);
  assert.equal(state().failCount, 0);
  assert.ok(state().lastSuccessAt);
  assert.ok(!("sk-verify" in db.alarms));
  assert.deepEqual(db.removedTabs, []); // tab của người dùng không bị đóng
});

test("không có tab nền → mở tab mới ở nền và đóng nó sau khi xong", async () => {
  db.cookies.access_token = makeJwt({ exp: nowSec() + 60 });
  db.tabs.push({ id: 1, url: SITE + "/", active: true, windowId: 1 });
  await bg.startRefresh();
  const worker = state().workerTabId;
  assert.notEqual(worker, 1);
  assert.equal(state().workerTabCreated, true);
  assert.deepEqual(db.reloaded, []); // tab đang xem không bị reload

  db.cookies.access_token = makeJwt({ exp: nowSec() + 86400 });
  await bg.onTokenCookieChanged();
  assert.deepEqual(db.removedTabs, [worker]);
});

test("không reload lại khi lần thử trước còn quá gần", async () => {
  db.cookies.access_token = makeJwt({ exp: nowSec() + 60 });
  db.tabs.push({ id: 2, url: SITE + "/", active: false, windowId: 1 });
  db.local.state.lastAttemptAt = Date.now() - 10_000;
  await bg.startRefresh();
  assert.deepEqual(db.reloaded, []);
  assert.ok(db.alarms["sk-refresh"] > Date.now());
});

test("gặp CAPTCHA → dừng tự động và báo người dùng", async () => {
  db.cookies.access_token = makeJwt({ exp: nowSec() + 60 });
  db.tabs.push({ id: 2, url: SITE + "/", active: false, windowId: 1 });
  await bg.startRefresh();
  db.pageState = { captcha: true, login: false, path: "/" };
  await bg.verifyRefresh();

  assert.equal(state().status, "needs_attention");
  assert.match(db.notifications.at(-1), /CAPTCHA/);
  assert.ok(!("sk-refresh" in db.alarms));
});

test("gặp trang đăng nhập → báo cần đăng nhập lại", async () => {
  db.cookies.access_token = makeJwt({ exp: nowSec() + 60 });
  db.tabs.push({ id: 2, url: SITE + "/", active: false, windowId: 1 });
  await bg.startRefresh();
  db.pageState = { captcha: false, login: true, path: "/login" };
  await bg.verifyRefresh();
  assert.equal(state().status, "needs_attention");
  assert.match(state().message, /đăng nhập lại/);
});

test("thất bại không rõ lý do → thử lại, quá số lần thì dừng", async () => {
  db.cookies.access_token = makeJwt({ exp: nowSec() + 60 });
  db.tabs.push({ id: 2, url: SITE + "/", active: false, windowId: 1 });

  for (let i = 1; i <= 3; i++) {
    db.local.state.lastAttemptAt = null; // bỏ qua khoảng chờ giữa các lần
    await bg.startRefresh();
    await bg.verifyRefresh();
    assert.equal(state().failCount, i);
  }
  assert.equal(state().status, "stopped");
  assert.ok(!("sk-refresh" in db.alarms));

  // Đang dừng thì alarm tự động không reload nữa
  const before = db.reloaded.length;
  await bg.startRefresh();
  assert.equal(db.reloaded.length, before);
});

test("người dùng đăng nhập lại sau khi bị dừng → hoạt động trở lại", async () => {
  db.cookies.access_token = makeJwt({ exp: nowSec() + 60 });
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
  db.tabs.push({ id: 2, url: SITE + "/", active: false, windowId: 1 });
  await bg.schedule();
  await bg.startRefresh();
  const dump = JSON.stringify({ sync: db.sync, local: db.local });
  assert.ok(!dump.includes(token.split(".")[1]));
});
