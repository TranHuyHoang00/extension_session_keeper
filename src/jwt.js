// Giải mã phần payload của JWT để đọc các mốc thời gian.
// Chỉ đọc, không kiểm tra chữ ký: extension không dùng token để xác thực gì cả.

export function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** Trả về exp (giây, Unix) hoặc null nếu không đọc được. */
export function getExp(token) {
  const p = decodeJwtPayload(token);
  return p && Number.isFinite(p.exp) ? p.exp : null;
}
