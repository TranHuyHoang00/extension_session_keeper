# Session Keeper

Chrome extension (Manifest V3) giữ phiên đăng nhập của website công ty luôn còn hiệu lực:
khi access token sắp hết hạn, extension **để chính website tự làm mới token**, không tự gọi API nào.

Có thể giữ phiên cho **nhiều website cùng lúc**, mỗi website ở **một tab đã gắn**. Mỗi tab chạy độc lập
với tên cookie, lịch làm mới, trạng thái và lịch sử riêng. Tab chưa gắn không bị ảnh hưởng,
và extension không bao giờ tự mở tab mới.

## Cách hoạt động

1. Bạn mở website và bấm icon extension: side panel mở ra và tab đó **được gắn luôn**, không cần xác nhận thêm.
2. Extension đọc cookie chứa access token (JWT) bằng `chrome.cookies`, kể cả cookie HttpOnly, và lấy trường `exp`.
3. Hẹn giờ bằng `chrome.alarms` theo cách làm mới của website (xem bên dưới).
4. Đến giờ, extension reload **tab đã gắn**, và website tự dùng refresh token để lấy token mới.
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

### Khi nào reload: sau hay trước khi token hết hạn

Mỗi website chọn một trong hai cách trong phần Cài đặt:

| Cách | Khi nào dùng | Extension làm gì |
|---|---|---|
| **Sau khi hết hạn** (mặc định) | Website chỉ refresh khi gọi API bị lỗi 401: token hết hạn → API lỗi → frontend mới dùng refresh token | Chờ token hết hạn thêm vài giây (mặc định 10s) rồi reload. Trang tải lại gọi API bằng token đã hết hạn, nhận lỗi và tự refresh |
| **Trước khi hết hạn** | Website tự refresh lúc tải trang nếu token sắp hết hạn | Reload trước khi hết hạn một khoảng (mặc định 180s) |

Với cách "sau khi hết hạn", nếu trình duyệt xoá cookie token đúng lúc nó hết hạn (cookie có `Expires` trùng `exp`),
extension hiểu đó là token vừa hết hạn và vẫn reload, không coi là đã đăng xuất.

### Nhiều website

- Mỗi website có **cài đặt riêng** (tên cookie, thời gian làm mới, bật/tắt), lưu theo tên miền.
  Lần sau gắn lại tab của website đó sẽ dùng luôn cài đặt cũ.
- Mỗi tab có alarm riêng, nên hai website hết hạn vào hai thời điểm khác nhau không ảnh hưởng nhau.
- Website A gặp lỗi (CAPTCHA, phải đăng nhập lại, dừng) thì website B vẫn chạy bình thường.
- **Mỗi website chỉ giữ ở một tab.** Hai tab cùng website dùng chung cookie; nếu cả hai cùng reload,
  refresh token có thể bị dùng lại và server thu hồi cả phiên. Gắn tab thứ hai của cùng website
  sẽ chuyển việc giữ phiên sang tab mới.

### Các tình huống với tab đã gắn

| Tình huống | Extension làm gì |
|---|---|
| Đóng tab đã gắn | Bỏ gắn, ngừng giữ phiên, hiện thông báo |
| Tab đã gắn chuyển sang website khác | Không reload trang lạ; báo bạn quay lại website, 5 phút sau thử lại |
| Khởi động lại trình duyệt | Bỏ gắn tất cả (mã tab cũ không còn đúng), báo một lần để bạn gắn lại |
| Gắn tab khác của **cùng** website | Tab cũ được bỏ gắn, website chuyển sang tab mới |
| Gắn tab của website **khác** | Thêm website mới, các website cũ vẫn chạy |

Side panel mặc định tắt cho mọi tab: bấm icon ở tab nào thì chỉ tab đó có panel, mở tab mới sẽ không thấy panel.
Badge **ON** hiện trên từng tab đã gắn.

## Cài đặt (chế độ developer)

1. Mở `chrome://extensions`, bật **Developer mode**.
2. Bấm **Load unpacked**, chọn thư mục gốc của repo này.
3. Mở website và đăng nhập, bấm icon extension. Side panel mở ra và tab được gắn ngay.
4. Trong side panel bấm **Cài đặt** (mở ngay trong panel, không mở tab mới), nhập **tên cookie chứa access token của website đó** (xem trong DevTools → Application → Cookies), bấm **Lưu** rồi **Kiểm tra cookie**.
5. Side panel hiển thị trạng thái: thời điểm token hết hạn, lần làm mới tiếp theo, lần làm mới gần nhất, và các website khác đang được giữ.
6. Muốn giữ thêm website khác: mở website đó ở tab khác và làm lại bước 3–4.

## Lịch sử (terminal)

Phía dưới side panel có khung **Lịch sử** dạng terminal, cập nhật ngay khi có sự kiện:

| Mức | Ví dụ |
|---|---|
| `INFO` | Gắn/bỏ gắn tab, hẹn giờ làm mới, reload tab, lưu cài đặt, cập nhật extension |
| `SUCCESS` | Đã có token mới và giờ hết hạn mới |
| `WARN` | Token chưa đổi sau khi reload, gặp CAPTCHA, trang đăng nhập, tab chuyển sang trang khác |
| `ERROR` | Dừng sau nhiều lần thất bại, lỗi không mong muốn, không mở được panel |
| `DEBUG` | Chi tiết: alarm chạy, cookie thay đổi, các lần bỏ qua |

- Phạm vi: **Web này** (website của tab đang mở panel) hoặc **Mọi web** (mỗi dòng có tên miền đứng trước).
- Bộ lọc: **Tất cả** (ẩn debug), **Lỗi & cảnh báo**, **Chi tiết**.
- **Chép** để gửi log khi báo lỗi, **Xoá** để làm sạch.
- Lưu tối đa 500 dòng gần nhất trong `chrome.storage.local`. Log **không bao giờ chứa giá trị token**.

## Điều kiện để giải pháp hoạt động

Cần kiểm tra tay trước: **khi token đã hết hạn, reload trang có làm website tự refresh token không?**
Điều này cần trang gọi ít nhất một API dùng token ngay khi tải (ví dụ lấy thông tin người dùng),
để nhận lỗi 401 và kích hoạt refresh.

Cách thử nhanh, không phải chờ 24 giờ: mở DevTools → Application → Cookies, xoá **chỉ** cookie access token
(giữ cookie refresh token), rồi bấm **Làm mới ngay** trong side panel. Nếu khung Lịch sử hiện
`SUCCESS Đã có token mới…` là giải pháp chạy được với website đó.

## Giới hạn (đúng thiết kế)

- Tab đã gắn sẽ bị reload định kỳ (khoảng mỗi lần token gần hết hạn). Nếu bạn đang nhập dở trên tab đó, dữ liệu chưa lưu có thể mất.
  Nên gắn vào một tab riêng chỉ để giữ phiên.
- Máy tắt hoặc ngủ, hay trình duyệt đóng: extension không chạy. Khi máy thức dậy, alarm bị lỡ sẽ chạy ngay.
- **Refresh token hết hạn hoặc bị thu hồi**: không thể làm mới nữa, người dùng phải đăng nhập lại.
- **CAPTCHA**: extension chỉ phát hiện để báo, không vượt qua CAPTCHA.
- Các tab chưa gắn của website vẫn chạy logic riêng của website; extension không can thiệp vào chúng.

## Bảo mật

- Để gắn tab không phải hỏi quyền mỗi lần, extension xin sẵn `host_permissions` cho mọi trang https khi cài.
  Nếu chỉ dùng cho một số website cố định của công ty, nên thu hẹp danh sách này trong `manifest.json`,
  ví dụ `"https://*.congty.vn/*"`, để bộ phận bảo mật dễ duyệt hơn.
- Extension chỉ đọc cookie và reload tab của những tab bạn đã gắn; các trang khác không bị đụng tới.
- **Không lưu giá trị token** vào storage, và **mặc định không gửi token đi đâu**; chỉ lưu các mốc thời gian.
- Script kiểm tra trang chỉ trả về pathname, không trả query string.

## Đẩy token lên server (tuỳ chọn, mặc định tắt)

Dùng khi một máy/dự án **khác** cần lấy token mới nhất mà extension đang giữ. Trong Cài đặt của
một website, mở mục **Nâng cao → đẩy token lên server** và nhập:

- **URL server nhận token**: endpoint `POST` của server bạn dựng (ví dụ qua ngrok).
- **Khóa bí mật**: chuỗi trùng với server, gửi trong header `X-Session-Keeper-Key`.

Mỗi khi website đó có token mới, extension gửi:

```
POST <relayUrl>
X-Session-Keeper-Key: <relayKey>
Content-Type: application/json

{ "site": "app.congty.vn", "cookie": "privateToken", "token": "<JWT>", "exp": 1792722565 }
```

Dự án bên kia gọi `GET` lên server đó (kèm cùng khóa) để lấy token mới nhất.

**Xem đã gửi được chưa:** side panel hiện dòng **Đẩy token** với kết quả và giờ gửi gần nhất
(ví dụ `Bật → host · ✓ đã gửi tới host (14:31:14)`), và khung Lịch sử ghi mỗi lần gửi.
Extension chỉ tự gửi khi có **token mới**; để kiểm tra ngay, bấm nút **Gửi token lên server ngay**.

**Cảnh báo:** bật tính năng này nghĩa là extension **gửi giá trị token production ra ngoài trình duyệt**.
Chỉ dùng với server bạn kiểm soát, luôn đặt khóa bí mật, dùng HTTPS, và **nên hỏi bộ phận bảo mật trước**.
Nếu mục tiêu là để một máy tự động gọi API, giải pháp chuẩn hơn là xin **tài khoản dịch vụ (client credentials)**.
Server nhận token nằm ở một repo riêng, không thuộc extension này.

## Cấu trúc

```
manifest.json
src/
  background.js      service worker: gắn tab, lên lịch, reload, xác minh, thông báo
  config.js          cài đặt theo website, các tab đang gắn, trạng thái theo tab (chrome.storage)
  jwt.js             đọc exp từ JWT
  log.js             ghi và định dạng lịch sử sự kiện
  detect.js          inject vào trang để phát hiện CAPTCHA / trang đăng nhập
  panel/             side panel theo từng tab (gắn / bỏ gắn tab, trạng thái, cài đặt, lịch sử)
  ui.css
icons/
```

## Phát triển

```bash
npm run check   # kiểm tra cú pháp
npm run zip     # đóng gói session-keeper.zip
```

Các thông số nâng cao dùng chung cho mọi website (khoảng chờ xác minh, khoảng cách giữa các lần thử,
số lần thất bại tối đa) nằm trong `DEFAULTS` ở `src/config.js`. Cài đặt mặc định của một website mới
nằm trong `DEFAULT_SITE`.
