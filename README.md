# Vietlott Realtime V5

Node.js + Express + Socket.IO + MongoDB (tuỳ chọn) + Telegram webhook (tuỳ chọn).

## Tính năng
- 5 game: Mega 6/45, Power 6/55, Lotto 5/35, Max3D Pro, Max 3D.
- Giao diện bóng số, trang riêng theo game bằng `?game=...`.
- Lịch sử 20–50 kỳ. Nên dùng MongoDB để lịch sử không mất khi Render sleep/redeploy.
- Dò vé nhanh.
- Lưu vé theo trình duyệt (`ownerKey` localStorage).
- Tự dò vé khi crawler nhận kỳ mới.
- Telegram webhook: bot trả Chat ID khi `/start`, server gửi cảnh báo khi vé có kết quả trùng.

## Render
Build Command: `npm install`
Start Command: `npm start`

### Environment
- `MONGODB_URI` — khuyến nghị, để lưu lịch sử và vé bền vững.
- `TELEGRAM_BOT_TOKEN` — token từ BotFather, nếu muốn Telegram.
- `PUBLIC_URL` — có thể để trống trên Render; app dùng `RENDER_EXTERNAL_URL` nếu có.
- `ADMIN_KEY` — khoá cho API refresh admin.
- `REFRESH_MS` — mặc định 30000, tối thiểu 15000 ms.

## Telegram
1. Tạo bot với BotFather và đặt `TELEGRAM_BOT_TOKEN` trên Render.
2. Redeploy.
3. Nhắn `/start` cho bot để nhận Chat ID.
4. Nhập Chat ID khi lưu vé trên web.

> Cảnh báo dò vé chỉ hỗ trợ đối chiếu. Cần kiểm tra lại cơ cấu giải/kết quả chính thức trước khi lĩnh thưởng.

## Admin V6
Mở `/admin`. Trên Render đặt biến môi trường `ADMIN_KEY` thành mật khẩu mạnh (không dùng mặc định 123456).
Admin có thể: đổi URL nguồn từng game, xem trạng thái/lần crawl cuối, bật/tắt tự dò vé, crawl thủ công, xem/tắt/xóa toàn bộ vé, và gửi kết quả hiện tại qua Telegram.
Nếu có MongoDB, cấu hình nguồn và trạng thái tự dò được lưu bền vững trong collection `settings`.
