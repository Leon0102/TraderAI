# TraderAI

Bảng điều khiển chứng khoán Việt Nam: dữ liệu thị trường, chấm điểm có kiểm định, Hội đồng AI, và
phân tích tài khoản TCBS **chỉ đọc** (danh mục, rủi ro, dự báo, nhật ký, báo cáo tuần).

> Công cụ nghiên cứu cá nhân, không phải khuyến nghị đầu tư. Các con số backtest có thiên lệch sống sót.

## Chạy nhanh

| Cách | Lệnh | Địa chỉ |
|---|---|---|
| Docker (khuyên dùng) | `docker compose up -d --build` | http://localhost:8080 |
| Docker + tự đồng bộ & sao lưu | `docker compose --profile autosync up -d` | như trên |
| Không Docker | `npm run local` (cần `pip install -r docker/backend-requirements.txt`) | http://localhost:5173 |

Lần đầu: mở mục **Định lượng → Dữ liệu → Nạp dữ liệu** (~2 phút) để nạp toàn bộ HOSE/HNX/UPCoM.

## Tài khoản TCBS

1. Tạo API key trong TCInvest, lưu vào `key.txt` ở thư mục gốc (đã bị gitignore, chỉ mount đọc-only vào container).
2. Lúc mở app, nhập **iOTP** (TCInvest → Cài đặt → Bảo mật → iOTP → Nhận mã iOTP, hiệu lực ~30–60 giây).
   Token dùng tối đa 8 giờ; TCBS giới hạn 10 lần đổi token mỗi ngày.
3. Số lưu ký (`105C…`) được lấy từ token; `TCBS_CUSTODY_CODE` trong `.env.local` chỉ là dự phòng.

Bảo mật: mọi endpoint `/api/account/*` chỉ nhận request từ máy local / mạng Docker và từ tên miền
được cấu hình (kiểm tra cả `Origin` lẫn `Host` để chống DNS rebinding). Key có quyền đặt lệnh, nên app
**chỉ có lệnh đọc** và không bao giờ được đưa lên Vercel.

## Dữ liệu lưu ở đâu

- Docker: Postgres (`pgdata`) — tài liệu tài khoản (JSONB) và các bảng thị trường.
- Không Docker: file trong `runtime/` và `runtime/market.db` (SQLite). Hai nơi lưu này **độc lập**.
- Lần đầu chạy Docker, các file JSON cũ trong `runtime/` được nhập vào Postgres một lần.

## Triển khai lên VPS

```bash
cp .env.example .env     # điền DOMAIN, APP_PASSWORD, AUTH_SECRET (openssl rand -hex 32), POSTGRES_PASSWORD
# chép key.txt và .env.local lên VPS (không nằm trong git)
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile autosync up -d --build
```

Overlay `prod` thêm Caddy (HTTPS tự động cho `DOMAIN`), đóng mọi cổng ngoài 80/443, và **bắt buộc**
đăng nhập bằng mật khẩu (sai 5 lần thì khóa 15 phút). Thiếu biến bắt buộc thì compose từ chối chạy.

Chuyển dữ liệu từ máy này sang VPS: `scripts/backup-db.sh` ở máy cũ, chép file trong `backups/`, rồi
`scripts/backup-db.sh --restore <file>` trên VPS.

## Sao lưu

`--profile autosync` chạy thêm dịch vụ `backup`: dump Postgres mỗi ngày vào `./backups` (giữ 14 bản).
Chạy tay: `scripts/backup-db.sh`.

## Lịch tự động (profile `autosync`)

Thứ 2–6: đồng bộ tài khoản 11:35 và 15:05 (gửi cảnh báo Telegram / thông báo macOS), nạp dữ liệu thị trường +
kiểm định lại 15:30, báo cáo tuần vào thứ Sáu. Cần token TCBS còn hạn: buổi sáng nhập OTP một lần.
Bot Telegram (nếu đặt `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) trả lời `/nav /holdings /rules` chỉ bằng tỷ lệ %.

## Kiểm thử

```bash
npm test                       # frontend (vitest)
npm run test:py                # backend, offline (PYTHON=/usr/bin/python3 nếu python3 thiếu numpy/fastapi)
npm run lint:py                # ruff: tên chưa định nghĩa, import thừa
docker compose build           # image dựng được
```

CI (GitHub Actions) chạy đủ các bước trên cho mỗi lần push.

## Cấu trúc backend

| Nhóm | File |
|---|---|
| HTTP | `server.py` (khởi động) · `routes_*.py` · `guards.py` (ai được đọc tài khoản) · `auth_gate.py` (mật khẩu) |
| TCBS | `tcbs_account.py` (đăng nhập, sync, sổ cái tiền) · `nav_history.py` · `personal_rules.py` · `pretrade.py` |
| Phân tích danh mục | `portfolio_plan.py` · `portfolio_insights.py` · `forecast.py` · `risk_tools.py` · `portfolio_advanced.py` |
| Thị trường | `market_db.py` · `market_ingest.py` · `scoring.py` · `factor_validation.py` · `market_views.py` · `quant_service.py` |
| Tự động | `autosync.py` · `notify.py` · `telegram_bot.py` · `weekly_report.py` |
| Theo dõi kết quả | `forecast_tracking.py` · `council_log.py` · forward test trong `quant_service.py` |
