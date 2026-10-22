# Session Keeper

Chrome extension (Manifest V3) giữ phiên đăng nhập của website công ty luôn còn hiệu lực:
khi access token sắp hết hạn, extension **để chính website tự làm mới token**, không tự gọi API nào.

## Cách hoạt động

1. Đọc cookie chứa access token (JWT) bằng `chrome.cookies`, kể cả cookie HttpOnly, và lấy trường `exp`.
2. Hẹn giờ bằng `chrome.alarms` để chạy trước `exp` một khoảng (mặc định 3 phút).
3. Đến giờ, reload **đúng một** tab của website mà người dùng không đang xem.
   Nếu không có tab nào như vậy thì mở một tab nền mới, rồi tự đóng sau khi xong.
   Frontend của website tải lại sẽ tự dùng refresh token để lấy token mới.
4. Theo dõi `chrome.cookies.onChanged`: thấy token mới có `exp` lớn hơn thì coi là thành công và hẹn lịch tiếp theo.
5. Sau 60 giây mà token chưa đổi, extension kiểm tra trang:
   - Có CAPTCHA hoặc trang đăng nhập: **dừng tự động**, hiện thông báo; bấm vào thông báo để mở trang và tự xử lý.
   - Lỗi không rõ: thử lại sau 5 phút; thất bại 3 lần liên tiếp thì tạm dừng.
6. Khi người dùng đăng nhập lại (cookie token mới xuất hiện), extension tự hoạt động trở lại.

```
cookie (exp) ──► alarm (exp − margin) ──► reload 1 tab ──► website tự refresh
     ▲                                                          │
     └──────────── cookies.onChanged (token mới) ◄──────────────┘
```

## Cài đặt (chế độ developer)

1. Mở `chrome://extensions`, bật **Developer mode**.
2. Bấm **Load unpacked**, chọn thư mục gốc của repo này.
3. Trang Cài đặt sẽ tự mở. Nhập:
   - **Địa chỉ website**: ví dụ `https://app.congty.vn`
   - **Tên cookie chứa access token**: xem trong DevTools → Application → Cookies
4. Bấm **Lưu** và đồng ý cấp quyền cho website đó.
5. Đăng nhập website như bình thường, sau đó bấm **Kiểm tra cookie** để xác nhận extension đọc được hạn token.

Bấm icon extension để xem trạng thái: thời điểm token hết hạn, lần làm mới tiếp theo, lần làm mới gần nhất.

## Điều kiện để giải pháp hoạt động

Cần kiểm tra tay trước: **khi reload trang lúc token sắp hoặc vừa hết hạn, website có tự refresh token không?**
Nếu frontend chỉ refresh khi gọi API bị 401, hoặc không refresh lúc tải trang, thì việc reload sẽ không tạo token mới.

## Giới hạn (đúng thiết kế)

- Máy tắt hoặc ngủ, hay trình duyệt đóng: extension không chạy. Khi mở lại, alarm bị lỡ sẽ chạy ngay.
- **Refresh token hết hạn hoặc bị thu hồi**: không thể làm mới nữa, người dùng phải đăng nhập lại.
- **CAPTCHA**: extension chỉ phát hiện để báo, không vượt qua CAPTCHA.
- Extension chỉ đảm bảo **bản thân nó** không refresh trùng. Nếu website mở nhiều tab và mỗi tab tự refresh
  theo logic riêng, việc tranh chấp refresh token (khi server xoay vòng token) là do website quyết định.

## Bảo mật

- Quyền truy cập website là `optional_host_permissions`: chỉ xin đúng domain người dùng nhập, không dùng `<all_urls>`.
- **Không lưu giá trị token** vào storage, không gửi token đi đâu; chỉ lưu các mốc thời gian.
- Script kiểm tra trang chỉ trả về pathname, không trả query string.

## Cấu trúc

```
manifest.json
src/
  background.js      service worker: lên lịch, reload tab, xác minh, thông báo
  config.js          cấu hình và trạng thái (chrome.storage)
  jwt.js             đọc exp từ JWT
  detect.js          inject vào trang để phát hiện CAPTCHA / trang đăng nhập
  popup/             giao diện khi bấm icon
  options/           trang cài đặt
  ui.css
icons/
test/                test logic background với chrome giả lập (Node)
```

## Phát triển

```bash
npm test        # chạy test (Node 18+), không cần cài thư viện
npm run check   # kiểm tra cú pháp
npm run zip     # đóng gói session-keeper.zip
```

Các thông số nâng cao (khoảng chờ xác minh, khoảng cách giữa các lần thử, số lần thất bại tối đa)
nằm trong `DEFAULT_CONFIG` ở `src/config.js`.
