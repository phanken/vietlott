# Vietlott Realtime - Render

Node.js + Express + Socket.IO. Tự cập nhật kết quả, phát realtime tới trình duyệt, hỗ trợ MongoDB lưu lịch sử.

## Chạy local
```bash
npm install
npm start
```
Mở http://localhost:10000

## Biến môi trường Render
- `MONGODB_URI`: MongoDB Atlas URI (không bắt buộc; không có thì web vẫn chạy nhưng không lưu lịch sử).
- `ADMIN_KEY`: khóa cho API admin.
- `REFRESH_MS`: chu kỳ kiểm tra nguồn, mặc định 30000 ms, tối thiểu 15000 ms.

## API
- `GET /api/results`
- `GET /api/results/mega`
- `GET /api/results/power`
- `GET /api/results/lotto`
- `GET /api/history/mega`
- `POST /api/admin/refresh` với header `x-admin-key`
- `GET /health`

## Deploy Render
Push toàn bộ project lên GitHub, tạo Web Service trên Render, chọn repo, Build Command `npm install`, Start Command `npm start`.
