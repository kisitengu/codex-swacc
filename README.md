# Switch Codex Accounts

CLI nhỏ gọn giúp quản lý và chuyển nhanh giữa nhiều tài khoản Codex bằng cách
thay thế file `~/.codex/auth.json`. Công cụ cũng có thể kiểm tra quota của tất
cả tài khoản và tự động chọn tài khoản còn nhiều quota 5 giờ nhất.

> [!CAUTION]
> Các file profile chứa thông tin xác thực. Không commit thư mục `profiles/`
> hoặc chia sẻ những file này.

## Yêu cầu

- Node.js 18 trở lên
- Codex CLI đã được cài đặt và có thể gọi bằng lệnh `codex`

## Cài đặt

Clone repository, sau đó tạo command `codex-acc` trên máy:

```sh
git clone git@github.com:kisitengu/codex-swacc.git
cd codex-swacc
npm link
```

Kiểm tra cài đặt:

```sh
codex-acc --help
```

## Quản lý profile

Lưu tài khoản Codex hiện tại thành một profile:

```sh
codex-acc save personal
```

Hoặc tự đặt file xác thực vào thư mục `profiles/`:

```text
profiles/
├── personal.json
└── work.json
```

Mỗi profile phải là một file JSON hợp lệ có nội dung tương ứng với
`~/.codex/auth.json`.

## Cách sử dụng

| Lệnh | Chức năng |
| --- | --- |
| `codex-acc list` | Liệt kê các profile đã lưu |
| `codex-acc current` | Hiển thị profile đang được sử dụng |
| `codex-acc use <profile>` | Chuyển sang profile được chọn |
| `codex-acc save <profile>` | Lưu tài khoản hiện tại thành profile mới |
| `codex-acc quota` | Kiểm tra quota của tất cả profile |
| `codex-acc quota --json` | Xuất kết quả quota dưới dạng JSON |
| `codex-acc sw` | Tự chọn và chuyển sang profile còn nhiều quota nhất |

Ví dụ:

```sh
codex-acc list
codex-acc use work
codex-acc current
```

Khi chạy `use`, công cụ sẽ:

1. Kiểm tra profile có phải JSON hợp lệ hay không.
2. Sao lưu file xác thực hiện tại thành
   `~/.codex/auth.json.backup-<timestamp>`.
3. Ghi profile được chọn vào `~/.codex/auth.json` với quyền truy cập riêng tư.

## Kiểm tra và tự động chuyển theo quota

```sh
codex-acc quota
```

Kết quả mẫu:

```text
work       5h [#################---]  84%  week [###################-]  97% <- best 5h
personal   5h [####----------------]  20%  week [########------------]  40%
```

Chạy lệnh sau để tự động chuyển sang profile có quota 5 giờ còn lại cao nhất:

```sh
codex-acc sw
```

Nếu tất cả profile đã hết quota 5 giờ, công cụ sẽ thử dùng reset credit khả
dụng, kiểm tra lại quota và chỉ chuyển tài khoản khi tìm thấy profile có thể
sử dụng.

## Biến môi trường

| Biến | Mặc định | Mô tả |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Thư mục cấu hình Codex |
| `CODEX_ACCOUNT_PROFILES` | `<project>/profiles` | Thư mục chứa profile |
| `CODEX_ACCOUNT_CODEX_BIN` | `codex` | Đường dẫn tới Codex CLI |

Ví dụ:

```sh
CODEX_HOME=/path/to/.codex codex-acc use work
CODEX_ACCOUNT_PROFILES=/path/to/profiles codex-acc list
CODEX_ACCOUNT_CODEX_BIN=/path/to/codex codex-acc quota
```

## Phát triển

```sh
npm run check
npm test
```

## License

UNLICENSED — chỉ sử dụng nội bộ.
