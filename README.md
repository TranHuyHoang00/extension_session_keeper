# Session Keeper

Chrome extension (Manifest V3) giữ phiên đăng nhập của website công ty luôn còn hiệu lực:
khi access token sắp hết hạn, extension **để chính website tự làm mới token**, không tự gọi API nào.

Extension chỉ làm việc với **đúng một tab mà bạn đã gắn**. Các tab khác, kể cả tab mới mở cùng website,
không bị ảnh hưởng, và extension không bao giờ tự mở tab mới.

## Cách hoạt động

1. Bạn mở website, bấm icon extension và chọn **Gắn vào tab này**.
2. Extension đọc cookie chứa access token (JWT) bằng `chrome.cookies`, kể cả cookie HttpOnly, và lấy trường `exp`.
3. Hẹn giờ bằng `chrome.alarms` để chạy trước `exp` một khoảng (mặc định 3 phút).
4. Đến giờ, extension reload **tab đã gắn**. Frontend của website tải lại sẽ tự dùng refresh token để lấy token mới.
5. Theo dõi `chrome.cookies.onChanged`: thấy token mới có `exp` lớn hơn thì coi là thành công và hẹn lịch tiếp theo.
6. Sau 60 giây mà token chưa đổi, extension kiểm tra tab:
   - Có CAPTCHA hoặc trang đăng nhập: **dừng tự động**, hiện thông báo; bấm vào thông báo để mở tab và tự xử lý.
   - Lỗi không rõ: thử lại sau 5 phút; thất bại 3 lần liên tiếp thì tạm dừng.
7. Khi bạn đăng nhập lại (cookie token mới xuất hiện), extension tự hoạt động trở lại.

```
gắn tab ──► cookie (exp) ──► alarm (exp − margin) ──► reload tab đã gắn ──► website tự refresh
                 ▲                                                               │
                 └──────────────── cookies.onChanged (token mới) ◄───────────────┘
```

### Các tình huống với tab đã gắn

| Tình huống | Extension làm gì |
|---|---|
| Đóng tab đã gắn | Bỏ gắn, ngừng giữ phiên, hiện thông báo |
| Tab đã gắn chuyển sang website khác | Không reload trang lạ; báo bạn quay lại website, 5 phút sau thử lại |
| Khởi động lại trình duyệt | Bỏ gắn (mã tab cũ không còn đúng), báo bạn gắn lại |
| Gắn sang tab khác | Tab cũ được bỏ gắn, chỉ tab mới được giữ phiên |

Badge **ON** chỉ hiện trên tab đã gắn.

## Cài đặt (chế độ developer)

1. Mở `chrome://extensions`, bật **Developer mode**.
2. Bấm **Load unpacked**, chọn thư mục gốc của repo này.
3. Trang Cài đặt sẽ tự mở. Nhập **tên cookie chứa access token** (xem trong DevTools → Application → Cookies) rồi bấm **Lưu**.
4. Mở website và đăng nhập, bấm icon extension, chọn **Gắn vào tab này** và đồng ý cấp quyền.
5. Bấm icon để xem trạng thái: thời điểm token hết hạn, lần làm mới tiếp theo, lần làm mới gần nhất.

## Điều kiện để giải pháp hoạt động

Cần kiểm tra tay trước: **khi reload trang lúc token sắp hoặc vừa hết hạn, website có tự refresh token không?**
Nếu frontend chỉ refresh khi gọi API bị 401, hoặc không refresh lúc tải trang, thì việc reload sẽ không tạo token mới.

Cách thử nhanh: trong Cài đặt đặt "Làm mới trước khi hết hạn" lớn (ví dụ 3600 giây), rồi bấm **Làm mới ngay** trong popup.
Nếu giờ hết hạn trong popup tăng lên thì giải pháp chạy được.

## Giới hạn (đúng thiết kế)

- Tab đã gắn sẽ bị reload định kỳ (khoảng mỗi lần token gần hết hạn). Nếu bạn đang nhập dở trên tab đó, dữ liệu chưa lưu có thể mất.
  Nên gắn vào một tab riêng chỉ để giữ phiên.
- Máy tắt hoặc ngủ, hay trình duyệt đóng: extension không chạy. Khi máy thức dậy, alarm bị lỡ sẽ chạy ngay.
- **Refresh token hết hạn hoặc bị thu hồi**: không thể làm mới nữa, người dùng phải đăng nhập lại.
- **CAPTCHA**: extension chỉ phát hiện để báo, không vượt qua CAPTCHA.
- Các tab khác của website vẫn chạy logic riêng của website; extension không can thiệp vào chúng.

## Bảo mật

- Quyền truy cập website là `optional_host_permissions`: chỉ xin đúng domain của tab bạn gắn, không dùng `<all_urls>`.
- **Không lưu giá trị token** vào storage, không gửi token đi đâu; chỉ lưu các mốc thời gian.
- Script kiểm tra trang chỉ trả về pathname, không trả query string.

## Cấu trúc

```
manifest.json
src/
  background.js      service worker: gắn tab, lên lịch, reload, xác minh, thông báo
  config.js          cấu hình, tab đang gắn và trạng thái (chrome.storage)
  jwt.js             đọc exp từ JWT
  detect.js          inject vào trang để phát hiện CAPTCHA / trang đăng nhập
  popup/             giao diện khi bấm icon (gắn / bỏ gắn tab, trạng thái)
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
