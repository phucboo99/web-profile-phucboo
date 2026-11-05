# Phucboo Agents

Bộ AI Agent cá nhân chạy bằng Claude, giao diện tiếng Việt / English (nút VI · EN góc trên bên trái). Mỗi agent làm một việc riêng: prompt video, prompt ảnh, QC test case, bug report, tải video Facebook/TikTok…

Website: **https://dinhtanphuc.github.io/web-profile-phucboo/**

## Cấu trúc

```
index.html          Khung giao diện
assets/agents.js    Danh sách agent + cấu hình chung  ← file bạn sửa nhiều nhất
assets/i18n.js      Chữ giao diện tiếng Việt / tiếng Anh
assets/app.js       Logic: chat, gọi Claude API, tải video
assets/style.css    Giao diện (tự đổi sáng/tối theo máy)
worker/worker.js    Máy chủ tải video, chạy trên Cloudflare (không chạy trên GitHub Pages)
```

## Cập nhật website

Vào repo trên GitHub → **Add file → Upload files** → kéo thả các file/thư mục ở trên vào (ghi đè file cũ) → **Commit changes**. Sau 1–2 phút website tự cập nhật, bấm Ctrl + F5 để xem bản mới.

## Lần đầu sử dụng

Mở website → nhập Anthropic API key (lấy tại https://console.anthropic.com/settings/keys). Key chỉ lưu trong trình duyệt của bạn, **không** nằm trong code trên GitHub.

> API tính phí theo lượng dùng, tách biệt với gói Claude Pro/Max. Nên đặt giới hạn chi tiêu (spend limit) trong Console.

## Cài máy chủ tải video (Cloudflare Worker, miễn phí)

GitHub Pages chỉ chạy web tĩnh, trình duyệt không được phép tự lấy video từ Facebook/TikTok. Worker là máy chủ nhỏ làm việc đó giúp website. Gói miễn phí cho 100.000 lượt/ngày, dư dùng.

1. Đăng ký / đăng nhập https://dash.cloudflare.com (miễn phí).
2. Menu trái chọn **Compute (Workers) → Workers & Pages** → **Create** → **Start with Hello World!** → đặt tên, ví dụ `phucboo-video` → **Deploy**.
3. Bấm **Edit code**, xoá hết code mẫu, dán toàn bộ nội dung file `worker/worker.js` vào → **Deploy**.
4. Copy địa chỉ Worker, dạng `https://phucboo-video.<tên-bạn>.workers.dev`. Mở địa chỉ đó trên trình duyệt, thấy dòng `"service":"phucboo-video"` là chạy được.
5. Mở `assets/agents.js`, điền địa chỉ vào cuối file rồi upload lại lên GitHub:
   ```js
   window.APP_CONFIG = {
     downloaderApi: "https://phucboo-video.<tên-bạn>.workers.dev"
   };
   ```
   (Hoặc chỉ dán vào **Cài đặt → Địa chỉ máy chủ tải video** trên website, áp dụng cho trình duyệt đó.)
6. Nên làm thêm: trong Worker vào **Settings → Variables and Secrets → Add**, tên `ALLOWED_ORIGINS`, giá trị `https://dinhtanphuc.github.io` → Deploy. Khi đó chỉ website của bạn dùng được máy chủ này.

### Agent tải video làm được gì

- **TikTok:** video không logo (bản gốc HD), video có logo, nhạc MP3, ảnh của bài đăng dạng slideshow. Dùng dịch vụ TikWM để lấy bản gốc.
- **Facebook:** video công khai (video thường, Reels, link fb.watch / share), bản HD và SD. Video Facebook vốn không có logo. Video trong nhóm kín, chỉ bạn bè xem, hoặc bắt đăng nhập thì không tải được.
- Dán nhiều link một lúc, mỗi dòng một link. Dán cả đoạn chia sẻ của TikTok cũng được, website tự lọc ra link.
- Chưa cài Worker thì TikTok vẫn thử lấy trực tiếp (có thể bị trình duyệt chặn), còn Facebook bắt buộc cần Worker.

Lưu ý: Facebook và TikTok thay đổi hệ thống thường xuyên, nên đôi khi cần cập nhật `worker.js`. Hãy chỉ tải video của bạn hoặc video được phép dùng lại, và ghi nguồn khi đăng lại nội dung của người khác.

## Thêm agent mới

- **Cách nhanh:** bấm “＋ Tạo agent” trên website. Agent lưu trong trình duyệt; dùng Cài đặt → “Xuất file JSON” để sao lưu hoặc chuyển sang máy khác.
- **Cách cố định (mọi thiết bị đều thấy):** mở `assets/agents.js`, copy một khối `{ ... }`, đổi `id`, `name`, `system`… rồi upload lại. Thêm `name_en`, `description_en`, `group_en`, `starters_en` để có bản tiếng Anh.

Mẹo: bấm ☆ để ghim agent dùng hằng ngày lên đầu. Link mở thẳng một agent: `?agent=qc-testcase`, mở bằng tiếng Anh: `?lang=en`.

## Bảo mật

- Không bao giờ dán API key vào file trong repo (repo public ai cũng đọc được).
- Không nhập key trên máy dùng chung. Muốn xoá: Cài đặt → “Xoá toàn bộ dữ liệu”.
- Nếu lỡ lộ key: vào Console thu hồi (revoke) key đó và tạo key mới.
