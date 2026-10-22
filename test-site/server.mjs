// Website giả lập để test Session Keeper trên máy, không cần thư viện ngoài.
//
// Mô phỏng đúng cơ chế "API lỗi rồi mới refresh":
//   - Đăng nhập → cookie `privateToken` (JWT, sống ACCESS_TTL giây) + cookie `refreshToken` (HttpOnly)
//   - Trang chỉ gọi API khi tải trang (không tự gọi định kỳ)
//   - Gọi /api/me bằng token hết hạn → 401 → frontend gọi /api/refresh → nhận token mới → gọi lại
//   - Refresh token được xoay vòng; dùng lại refresh token cũ → thu hồi cả phiên (giống Ory Hydra)
//
// Chạy:  node test-site/server.mjs
// Tuỳ chọn (biến môi trường):
//   PORT=4000                     cổng
//   ACCESS_TTL=120                access token sống bao nhiêu giây
//   REFRESH_TTL=1800              refresh token sống bao nhiêu giây
//   COOKIE_EXPIRES_WITH_TOKEN=1   cookie privateToken bị trình duyệt xoá đúng lúc token hết hạn (0 = giữ cookie)
//   CAPTCHA=0                     1 = trang đăng nhập có ô CAPTCHA giả (để test phát hiện CAPTCHA)

import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 4000);
const ACCESS_TTL = Number(process.env.ACCESS_TTL || 120);
const REFRESH_TTL = Number(process.env.REFRESH_TTL || 1800);
const COOKIE_EXPIRES_WITH_TOKEN = process.env.COOKIE_EXPIRES_WITH_TOKEN !== "0";
const CAPTCHA = process.env.CAPTCHA === "1";

const SECRET = crypto.randomBytes(32);
const now = () => Math.floor(Date.now() / 1000);
const time = (sec) => new Date(sec * 1000).toLocaleTimeString("vi-VN");

// ---------------------------------------------------------------------------
// JWT HS256 tối giản

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function signJwt(payload) {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

function verifyJwt(token) {
  const [head, body, sig] = String(token || "").split(".");
  if (!head || !body || !sig) return { ok: false, reason: "token sai định dạng" };
  const expected = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return { ok: false, reason: "chữ ký sai" };
  }
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  if (payload.exp <= now()) return { ok: false, reason: "token hết hạn", payload };
  return { ok: true, payload };
}

// ---------------------------------------------------------------------------
// Refresh token: chuỗi ngẫu nhiên (opaque), xoay vòng mỗi lần dùng

const refreshStore = new Map(); // token -> { sub, family, exp, used }
const revokedFamilies = new Set();

function issueTokens(sub, family = crypto.randomUUID()) {
  const iat = now();
  const access = signJwt({ sub, iat, nbf: iat, exp: iat + ACCESS_TTL, jti: crypto.randomUUID(), scp: ["openid", "offline"] });
  const refresh = `ory_rt_${crypto.randomBytes(24).toString("base64url")}`;
  refreshStore.set(refresh, { sub, family, exp: iat + REFRESH_TTL, used: false });
  return { access, refresh, accessExp: iat + ACCESS_TTL };
}

function tokenCookies({ access, refresh }) {
  const accessCookie = [
    `privateToken=${access}`,
    "Path=/",
    "SameSite=Lax",
    ...(COOKIE_EXPIRES_WITH_TOKEN ? [`Max-Age=${ACCESS_TTL}`] : []),
  ].join("; ");
  const refreshCookie = [`refreshToken=${refresh}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${REFRESH_TTL}`].join("; ");
  return [accessCookie, refreshCookie];
}

const clearCookies = [
  "privateToken=; Path=/; Max-Age=0",
  "refreshToken=; Path=/; HttpOnly; Max-Age=0",
];

// ---------------------------------------------------------------------------
// HTTP

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((c) => c.trim().split("="))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join("="))])
  );
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body === "object";
  res.writeHead(status, {
    "Content-Type": isJson ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(new URLSearchParams(data)));
  });
}

function logLine(...args) {
  console.log(`[${new Date().toLocaleTimeString("vi-VN")}]`, ...args);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cookies = parseCookies(req);

  // Trang đăng nhập
  if (url.pathname === "/login" && req.method === "GET") {
    return send(res, 200, loginPage(url.searchParams.get("reason")));
  }
  if (url.pathname === "/login" && req.method === "POST") {
    const form = await readBody(req);
    const user = (form.get("username") || "demo").trim() || "demo";
    const tokens = issueTokens(user);
    logLine(`ĐĂNG NHẬP ${user}: access hết hạn lúc ${time(tokens.accessExp)}`);
    return send(res, 302, "", { Location: "/", "Set-Cookie": tokenCookies(tokens) });
  }
  if (url.pathname === "/logout") {
    return send(res, 302, "", { Location: "/login", "Set-Cookie": clearCookies });
  }

  // API cần access token
  if (url.pathname === "/api/me") {
    const v = verifyJwt(cookies.privateToken);
    if (!v.ok) {
      logLine(`GET /api/me → 401 (${cookies.privateToken ? v.reason : "không có cookie privateToken"})`);
      return send(res, 401, { error: "unauthorized", reason: cookies.privateToken ? v.reason : "missing token" });
    }
    logLine(`GET /api/me → 200 (${v.payload.sub})`);
    return send(res, 200, { user: v.payload.sub, exp: v.payload.exp });
  }

  // Refresh: dùng refresh token để lấy cặp token mới
  if (url.pathname === "/api/refresh" && req.method === "POST") {
    const rt = cookies.refreshToken;
    const rec = rt && refreshStore.get(rt);
    const fail = (reason) => {
      logLine(`POST /api/refresh → 401 (${reason})`);
      return send(res, 401, { error: "invalid_grant", reason }, { "Set-Cookie": clearCookies });
    };
    if (!rec) return fail("không có hoặc không nhận ra refresh token");
    if (revokedFamilies.has(rec.family)) return fail("phiên đã bị thu hồi");
    if (rec.exp <= now()) return fail("refresh token hết hạn");
    if (rec.used) {
      revokedFamilies.add(rec.family);
      return fail("refresh token bị dùng lại → thu hồi cả phiên");
    }
    rec.used = true;
    const tokens = issueTokens(rec.sub, rec.family);
    logLine(`POST /api/refresh → 200: token mới hết hạn lúc ${time(tokens.accessExp)}`);
    return send(res, 200, { ok: true, exp: tokens.accessExp }, { "Set-Cookie": tokenCookies(tokens) });
  }

  // Trang chính
  if (url.pathname === "/") {
    if (!cookies.refreshToken && !cookies.privateToken) {
      return send(res, 302, "", { Location: "/login" });
    }
    return send(res, 200, appPage());
  }

  send(res, 404, "Không tìm thấy");
});

server.listen(PORT, () => {
  console.log(`
Website test đang chạy: http://localhost:${PORT}
  Access token sống ${ACCESS_TTL}s, refresh token sống ${REFRESH_TTL}s
  Cookie privateToken ${COOKIE_EXPIRES_WITH_TOKEN ? "bị xoá cùng lúc token hết hạn" : "được giữ lại sau khi token hết hạn"}
  CAPTCHA ở trang đăng nhập: ${CAPTCHA ? "BẬT" : "tắt"}
`);
});

// ---------------------------------------------------------------------------
// Giao diện

const css = `
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 32px auto; padding: 0 16px; color: #1f2328; }
  h1 { font-size: 20px; } code { background: #f6f8fa; padding: 1px 4px; border-radius: 4px; }
  .card { border: 1px solid #d0d7de; border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
  button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid #1f6feb; background: #1f6feb; color: #fff; cursor: pointer; }
  input { font: inherit; padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 6px; }
  #log { background: #0d1117; color: #c9d1d9; padding: 10px; border-radius: 8px; font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; min-height: 120px; }
  .ok { color: #1a7f37; } .bad { color: #cf222e; }
`;

function loginPage(reason) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Đăng nhập – Test Site</title><style>${css}</style></head>
<body>
  <h1>Đăng nhập (website test)</h1>
  ${reason ? `<p class="bad">Phiên đã hết: ${reason}</p>` : ""}
  <form method="post" action="/login" class="card">
    <p><label>Tên đăng nhập <input name="username" value="demo"></label></p>
    <p><label>Mật khẩu <input name="password" type="password" value="demo"></label></p>
    ${CAPTCHA ? `<div class="g-recaptcha" data-sitekey="fake-site-key" style="border:1px dashed #999;padding:12px;margin:8px 0">[CAPTCHA giả để test]</div>` : ""}
    <button>Đăng nhập</button>
  </form>
</body></html>`;
}

function appPage() {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Test Site</title><style>${css}</style></head>
<body>
  <h1>Website test cho Session Keeper</h1>
  <div class="card">
    <div>Người dùng: <b id="user">…</b></div>
    <div>Access token hết hạn lúc: <b id="exp">…</b> <span id="left"></span></div>
    <p style="margin-bottom:0">
      Trang này <b>chỉ gọi API khi tải trang</b>. Token hết hạn → <code>/api/me</code> trả 401 →
      frontend gọi <code>/api/refresh</code> → nhận token mới → gọi lại API.
    </p>
  </div>
  <p><button id="call">Gọi API thủ công</button> <a href="/logout">Đăng xuất</a></p>
  <div id="log"></div>
<script>
  const logEl = document.getElementById("log");
  const log = (msg, cls = "") => {
    const line = document.createElement("div");
    line.className = cls;
    line.textContent = "[" + new Date().toLocaleTimeString("vi-VN") + "] " + msg;
    logEl.append(line);
  };
  const readExp = () => {
    const m = document.cookie.match(/(?:^|; )privateToken=([^;]+)/);
    if (!m) return null;
    try { return JSON.parse(atob(m[1].split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp; } catch { return null; }
  };
  const showExp = () => {
    const exp = readExp();
    document.getElementById("exp").textContent = exp ? new Date(exp * 1000).toLocaleTimeString("vi-VN") : "(không có cookie)";
    const left = exp ? exp - Math.floor(Date.now() / 1000) : null;
    document.getElementById("left").textContent = left == null ? "" : left > 0 ? "(còn " + left + "s)" : "(đã hết hạn)";
  };
  setInterval(showExp, 1000);

  // Giống axios interceptor: gặp 401 thì refresh một lần rồi gọi lại.
  async function api(path) {
    let res = await fetch(path);
    log("GET " + path + " → " + res.status, res.ok ? "ok" : "bad");
    if (res.status !== 401) return res;
    const r = await fetch("/api/refresh", { method: "POST" });
    const body = await r.json().catch(() => ({}));
    log("POST /api/refresh → " + r.status + (body.reason ? " (" + body.reason + ")" : ""), r.ok ? "ok" : "bad");
    if (!r.ok) {
      location.href = "/login?reason=" + encodeURIComponent(body.reason || "không refresh được");
      return res;
    }
    res = await fetch(path);
    log("GET " + path + " (gọi lại) → " + res.status, res.ok ? "ok" : "bad");
    return res;
  }

  async function load() {
    const res = await api("/api/me");
    if (res.ok) document.getElementById("user").textContent = (await res.json()).user;
    showExp();
  }
  document.getElementById("call").onclick = load;
  load();
</script>
</body></html>`;
}
