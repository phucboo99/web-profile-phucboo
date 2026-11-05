# Phucboo Agents

Bộ AI Agent cá nhân chạy bằng Claude. Mỗi agent làm một việc riêng (prompt video, prompt ảnh, QC test case, bug report…), chọn agent bên trái là làm việc ngay.

Website tĩnh, chạy miễn phí trên GitHub Pages: **https://dinhtanphuc.github.io/web-profile-phucboo/**

## Cấu trúc

```
index.html          Khung giao diện
assets/agents.js    Danh sách agent mặc định  ← sửa file này để thêm/chỉnh agent
assets/app.js       Logic: chat, gọi Claude API, lưu lịch sử
assets/style.css    Giao diện (tự đổi sáng/tối theo máy)
.nojekyll           Cho GitHub Pages phục vụ file nguyên trạng
```

## Đưa lên GitHub Pages

1. Xoá file `abc` trong repo, chép toàn bộ thư mục này vào gốc repo rồi push lên nhánh `main`.
2. Vào repo trên GitHub → **Settings** → **Pages**.
3. Ở **Build and deployment**: Source chọn **Deploy from a branch**, Branch chọn **main** và thư mục **/ (root)** → **Save**.
4. Đợi 1–2 phút, mở https://dinhtanphuc.github.io/web-profile-phucboo/

Mỗi lần push code mới, GitHub tự cập nhật website.

## Lần đầu sử dụng

Mở website → nhập Anthropic API key (lấy tại https://console.anthropic.com/settings/keys). Key chỉ lưu trong trình duyệt của bạn, **không** nằm trong code trên GitHub. Mỗi trình duyệt / thiết bị nhập key một lần.

> Lưu ý: tài khoản API tính phí theo lượng dùng, tách biệt với gói Claude Pro/Max. Nên đặt giới hạn chi tiêu (spend limit) trong Console.

## Thêm agent mới

- **Cách nhanh:** bấm “＋ Tạo agent” trên website. Agent lưu trong trình duyệt; dùng Cài đặt → “Xuất file JSON” để sao lưu hoặc chuyển sang máy khác.
- **Cách cố định (mọi thiết bị đều thấy):** mở `assets/agents.js`, copy một khối `{ ... }`, đổi `id`, `name`, `system`… rồi push.

Mẹo: bấm ☆ cạnh agent để ghim agent dùng hằng ngày lên đầu. Có thể mở thẳng một agent bằng link `?agent=qc-testcase`.

## Bảo mật

- Không bao giờ dán API key vào file trong repo (repo public ai cũng đọc được).
- Không nhập key trên máy dùng chung. Muốn xoá: Cài đặt → “Xoá toàn bộ dữ liệu”.
- Nếu lỡ lộ key: vào Console thu hồi (revoke) key đó và tạo key mới.
