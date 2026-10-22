// Hàm này được inject vào tab của website (chrome.scripting.executeScript)
// để xem sau khi reload trang đang ở trạng thái nào.
// Nó phải tự chứa toàn bộ logic, không dùng biến bên ngoài.
// Extension chỉ PHÁT HIỆN CAPTCHA để báo người dùng, không tương tác với nó.

export function detectPageState() {
  const captchaRe = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com|captcha/i;
  const iframeHit = Array.from(document.querySelectorAll("iframe")).some((f) =>
    captchaRe.test(f.src || "")
  );
  const widgetHit = !!document.querySelector(
    ".g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]"
  );
  const challengeTitle = /just a moment|checking your browser|attention required/i.test(
    document.title || ""
  );

  const passwordField = !!document.querySelector('input[type="password"]');
  const loginPath = /(^|\/)(login|signin|sign-in|sign_in|dang-nhap|auth)(\/|$)/i.test(
    location.pathname
  );

  return {
    captcha: iframeHit || widgetHit || challengeTitle,
    login: passwordField || loginPath,
    // Chỉ trả về pathname, không trả query string (có thể chứa mã OAuth).
    path: location.pathname,
  };
}
