<div align="center">

<!-- TODO: thay bằng logo chính thức (hiện là icon của ứng dụng) -->
<img src="src-tauri/icons/128x128.png" alt="Logo Dockspan" width="96" height="96">

# Dockspan

**Ứng dụng desktop quản lý Docker & Kubernetes nhanh gọn, lấy thư mục dự án làm trung tâm.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/phanlyhuynh/dockspan?include_prereleases)](https://github.com/phanlyhuynh/dockspan/releases)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)
[![Stars](https://img.shields.io/github/stars/phanlyhuynh/dockspan?style=social)](https://github.com/phanlyhuynh/dockspan)

[Tải về](#cài-đặt) · [Tính năng](#tính-năng) · [Tài liệu](docs/connections.md) · [Đóng góp](CONTRIBUTING.md) · [English](README.md)

<img src="docs/screenshots/overview.png" alt="Màn hình Tổng quan của Dockspan" width="900">

</div>

## Vì sao chọn Dockspan?

- **Lấy dự án làm trung tâm.** Thêm một thư mục có file Compose hoặc Dockerfile rồi quản lý như một khối: up, stop, restart, down, sửa file.
- **Docker + Kubernetes trong một ứng dụng.** Container, image, volume và các cluster trong kubeconfig nằm cạnh nhau.
- **Dùng chung docker context với CLI.** Mỗi kết nối là một docker context thật, nên lệnh `docker` cũng thấy được.
- **Kết nối mọi loại engine.** Socket cục bộ, SSH, TCP+TLS và WSL2.
- **Nhẹ.** Tauri + Rust, không đóng gói cả trình duyệt và không chạy dịch vụ nền nặng.
- **Bí mật nằm trong Rust.** Webview không bao giờ chạm vào socket hay kubeconfig; giá trị trong `.env` được che.

## Tính năng

### Docker

<img src="docs/screenshots/containers-logs.png" alt="Bảng container và log trực tiếp" width="800">

- **Dự án:** thêm hoặc tự nhận diện dự án Compose, `compose up/stop/restart/down`, duyệt và sửa file; `.env` che các giá trị nhạy cảm.
- **Container:** tạo, chạy, dừng, khởi động lại, xóa; log realtime lọc theo mức, terminal xterm.js, thống kê, inspect.
- **Image:** pull có tiến trình, build, xem lịch sử layer, xóa.
- **Network & Volume:** duyệt, kèm sao lưu và khôi phục volume.
- **Điều khiển engine:** bật/tắt engine theo từng hệ điều hành, và hiện banner khi mất kết nối.

### Kubernetes

<img src="docs/screenshots/kubernetes.png" alt="Workload Kubernetes" width="800">

- Cluster lấy từ kubeconfig (không bao giờ bị sửa), độc lập với engine Docker.
- Deployment (scale, rollout restart), Pod (log, terminal exec, giải thích lỗi thường gặp), Service và port-forward.
- Danh sách cập nhật bằng watch, không phải polling.

<details><summary>Chi tiết hơn</summary>

Xem [docs/kubernetes.md](docs/kubernetes.md): namespace và cách xử lý lỗi 403, plugin xác thực exec (gcloud, aws, kubelogin), cách hoạt động của port-forward.

</details>

### Kết nối & SSH

<img src="docs/screenshots/connections.png" alt="Trang Kết nối" width="800">

- Thêm engine Docker qua SSH (lấy host từ `~/.ssh/config`), TCP+TLS hoặc WSL2 và chuyển đổi chỉ với một cú nhấp.
- Các distro WSL2 được liệt kê cùng phiên bản Docker, có nút cài Docker Engine.
- **Trang SSH** riêng với số tab terminal tùy ý cho mỗi host (nhập mật khẩu, vim/htop, đổi cỡ cửa sổ đều hoạt động).

<details><summary>Chi tiết hơn</summary>

Xem [docs/connections.md](docs/connections.md): docker context, cầu nối SSH/WSL2, file TLS, trang SSH.

</details>

### Dọn dẹp

<img src="docs/screenshots/cleanup.png" alt="Xem trước khi dọn dẹp" width="800">

- Xem trước chính xác thứ sẽ bị xóa trước khi xóa thật, rồi dọn thủ công hoặc theo lịch tự động.
- Network hay volume được coi là "đang dùng" nếu có bất kỳ container nào, kể cả đã dừng, tham chiếu tới.

### Khác

<img src="docs/screenshots/palette.png" alt="Bảng lệnh" width="800">

- **Bảng lệnh ⌘K / Ctrl+K** để nhảy tới container, image, dự án hay lệnh bất kỳ.
- **Giao diện tiếng Anh và tiếng Việt**, đổi ngay bằng nút bánh răng (Cài đặt) ở thanh trên.

## Cài đặt

<!-- TODO: chưa có bản phát hành trên GitHub Releases. Thêm link theo từng hệ điều hành khi có bản đầu tiên. -->

Tải bản mới nhất từ [GitHub Releases](https://github.com/phanlyhuynh/dockspan/releases) (TODO: macOS `.dmg`, Windows `.msi`/`.exe`, Linux `.deb`/`.AppImage`; chưa có Homebrew/winget).

**Build từ mã nguồn** (Node 20+, pnpm, Rust, Docker và [yêu cầu của Tauri](https://tauri.app/start/prerequisites/)):

```bash
pnpm install
pnpm tauri dev      # chạy ứng dụng
pnpm tauri build    # đóng gói
```

## Bắt đầu nhanh

1. Bật Docker (hoặc để Dockspan làm giúp bằng nút **Start Docker Engine** khi engine đang tắt). Nếu dùng engine khác ngoài máy local, chọn ở trang **Kết nối**.
2. Bấm **Thêm thư mục** và chọn dự án có `docker-compose.yml` hoặc `Dockerfile`.
3. Bấm chạy dự án, rồi mở **Container** để xem log hoặc mở terminal.
4. Nhấn **⌘K** bất cứ lúc nào để tìm kiếm; vào **Dọn dẹp** để xem trước dung lượng có thể giải phóng.

## Lộ trình

- ✅ Docker qua socket cục bộ / named pipe, SSH, TCP (+TLS), WSL2
- ✅ Tổng quan, Dự án (Compose), Container, Image, Network, Volume
- ✅ Dọn dẹp có xem trước và lịch tự động
- ✅ Kubernetes: Deployment, Pod, Service, port-forward
- ✅ Terminal SSH, bảng lệnh ⌘K, tiếng Anh/tiếng Việt
- ⬜ Context có `SkipTLSVerify`
- ⬜ StatefulSet / DaemonSet / Job và sửa YAML trong Kubernetes
- ⬜ Khôi phục port-forward khi khởi động lại
- ⬜ Khay hệ thống (tray) và thông báo
- ⬜ Giao diện sáng

## Đóng góp

Rất hoan nghênh issue và pull request. Hướng dẫn cài đặt, kiểm thử và kiến trúc nằm trong [CONTRIBUTING.md](CONTRIBUTING.md) (bằng tiếng Anh).

## Giấy phép

[MIT](LICENSE) © 2026 phanlyhuynh

## Lời cảm ơn

[Tauri](https://tauri.app), [bollard](https://github.com/fussybeaver/bollard), [kube-rs](https://github.com/kube-rs/kube), [portable-pty](https://github.com/wez/wezterm/tree/main/pty), [xterm.js](https://xtermjs.org), [React](https://react.dev), [Zustand](https://github.com/pmndrs/zustand), [Vite](https://vitejs.dev), cùng font IBM Plex Sans / JetBrains Mono.
