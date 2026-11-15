🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [Tiếng Việt](README.vi.md)

# MeMesh

**Lớp cộng tác cục bộ dành cho các trợ lý lập trình AI.**

MeMesh giúp các trợ lý lập trình AI chia sẻ ngữ cảnh, trao đổi công việc, góp ý cho nhau và bàn giao rõ ràng giữa các phiên. Bộ nhớ dùng chung giữ lại sở thích, quyết định của dự án và kinh nghiệm đã tích lũy, để bạn không phải giải thích lại từ đầu mỗi lần mở phiên mới.

- **Phân công giữa các hội thoại đã đăng ký.** Trao đổi công việc, câu hỏi, yêu cầu rà soát và kết quả. Manifest plugin của cả Claude và Codex đều khai báo hook hội thoại; việc nhận tin và đánh thức phiên gốc cần bằng chứng riêng cho từng host.
- **Dùng chung ngữ cảnh dự án.** Các trợ lý trên cùng một máy có thể tra lại quyết định và kinh nghiệm của dự án, thay vì tìm hiểu lại từ đầu.
- **Bàn giao rõ ràng.** Ghi lại mục tiêu, bước tiếp theo và vướng mắc để phiên sau kiểm tra trước khi tiếp tục.
- **Giữ lại những điều hữu ích.** Lưu sở thích, quyết định và bài học để tìm lại trong các phiên và công cụ khác nhau. Quyết định, bài học và sở thích được tìm thấy ở mọi dự án, kèm tên dự án gốc; commit và ghi chú phiên của mỗi dự án chỉ ở lại trong dự án đó.

Theo mặc định, bộ nhớ nằm trong một tệp trên máy của bạn: `~/.memesh/knowledge-graph.db`. MeMesh không cần mô hình AI riêng. Nhắc nhở tự động phụ thuộc vào tích hợp của từng công cụ; ghi chú bàn giao cung cấp ngữ cảnh, không bảo đảm công việc sẽ tự khởi động lại.

## Cài đặt

**Claude Code** — nhập các lệnh sau trong Claude Code, rồi khởi động lại:

```text
/plugin marketplace add PCIRCLE-AI/memesh
/plugin install memesh@pcircle-memesh
```

**Codex** — chạy các lệnh sau trong terminal, rồi khởi động lại Codex:

```bash
codex plugin marketplace add PCIRCLE-AI/memesh
codex plugin add memesh@pcircle-memesh
```

**Hermes Agent** — làm theo [hướng dẫn kết nối MeMesh với Hermes](docs/platforms/hermes-agent.md) để tìm lại và ghi nhận thông tin vào bộ nhớ.

Nếu cần dùng cả công cụ dòng lệnh, hãy cài [Node.js](https://nodejs.org) 26.13.1 trở lên trong nhánh 26.x (khuyến nghị), 24.22.3 trở lên trong nhánh 24.x, hoặc 22.23.5 trở lên trong nhánh 22.x, rồi chạy:

```bash
npm install -g @pcircle/memesh
memesh doctor
```

[Hướng dẫn cài đặt và cập nhật](llms-install.md) · [Các tích hợp khác](docs/platforms/README.md)

`PCIRCLE-AI/memesh` là kho GitHub cung cấp marketplace. `memesh@pcircle-memesh` chọn plugin `memesh` từ marketplace `pcircle-memesh`.

## Tin nhắn hội thoại (bản source thử nghiệm)

Dùng một phiên để triển khai thay đổi, một phiên khác để rà soát, đặt câu hỏi hoặc báo cáo kết quả. Tin nhắn hội thoại MeMesh chỉ có bốn thao tác: tìm địa chỉ, gửi nội dung có loại, đọc một tin nhắn nhận được và xem trạng thái/audit. Nội dung luôn là dữ liệu không đáng tin cậy.

1. Dùng các hội thoại đã đăng ký với cùng cấu hình cơ sở dữ liệu MeMesh. Cả hai plugin đều khai báo hook tin nhắn SessionStart/UserPromptSubmit. Luồng wire riêng theo định dạng Codex đã được kiểm tra; giao tới host native và mô hình thực vẫn cần xác minh riêng.
2. Chạy `memesh message discover` và chỉ chọn địa chỉ thực sự được liệt kê; không đoán người nhận.
3. Chỉ gửi nội dung qua stdin: `printf '%s' 'Hãy rà soát thay đổi này.' | memesh message send --recipient <address> --kind review_request --payload-stdin`. Bên nhận dùng `memesh message read --message-id <id>` và có thể trả lời bằng `--reply-to <id>`.

`queued` không có nghĩa đã giao, đã đọc, đã trả lời, đã chấp nhận hoặc đã hoàn tất. Đánh thức native và giao tin hội thoại liên máy vẫn đang được phát triển.

[Chi tiết thiết lập, định tuyến và biên nhận](docs/platforms/agent-messaging.md)

## Giữ lại ngữ cảnh cho phiên sau

Yêu cầu trợ lý bằng ngôn ngữ tự nhiên:

> Hãy nhớ rằng dự án này dùng SQLite.
>
> Lần trước chúng ta đã quyết định gì về đăng nhập?
>
> Lưu tiến độ hiện tại để phiên tiếp theo có thể tiếp tục.

MeMesh mặc định sẽ ghi nhớ. Để bỏ một bộ nhớ đã lưu, hãy yêu cầu trợ lý tìm đúng mục và dùng `forget`; các hội thoại khác tiếp tục được lưu như bình thường.

Plugin Claude Code cung cấp tính năng ghi nhận và nhắc nhở tự động. Plugin Codex có thể đưa ngữ cảnh vào đầu phiên khi được phép chạy các hook; những hành vi ghi nhận khác tùy thuộc công cụ. Bạn cũng có thể yêu cầu trợ lý lưu hoặc tìm bộ nhớ trực tiếp.

Các hook SessionStart/UserPromptSubmit, Claude Stop và sau công cụ Bash của Codex đưa toàn bộ tin đang chờ vào ngữ cảnh; chỉ ghi nhận giao sau khi xuất thành công. Hook bộ nhớ không còn hiển thị địa chỉ principal hoặc hướng dẫn hộp thư cũ. Việc đánh thức native và mô hình đọc tin vẫn cần xác minh; giao thức HTTP cũ được giữ riêng. Xem [hướng dẫn nhắn tin](docs/platforms/agent-messaging.md).

Từ MeMesh 4.11.0, Claude Code có thêm `/memesh-memories` để xem và sửa bộ nhớ dự án. Claude Desktop sửa ngay trong bảng; Claude Code trên terminal và Codex dùng biểu mẫu tích hợp sẵn. Trong Codex, yêu cầu `$memesh` tìm và sửa một bộ nhớ. Chỉ điền tiêu đề hoặc đoạn cần đổi, để trống các trường khác để giữ nguyên. Lưu sẽ đọc lại kết quả đã ghi; Hủy không ghi gì. Công cụ chưa hỗ trợ vẫn dùng quy trình hội thoại hiện có.

[Tham chiếu công cụ và lệnh](docs/api/API_REFERENCE.md) · [Nhắn tin giữa các trợ lý](docs/platforms/agent-messaging.md) · [Cách hoạt động](docs/ARCHITECTURE.md) · [Đóng góp](CONTRIBUTING.md)

<details>
<summary>Chi tiết công cụ và tích hợp</summary>

## Toàn bộ 12 công cụ bộ nhớ và phối hợp

| Công cụ | Chức năng |
|---------|-----------|
| `remember` | Lưu bộ nhớ (mặc định luôn lưu, không cần yêu cầu); lý do cho quyết định là tùy chọn, nên ghi khi đã biết. |
| `recall` | Tìm thông tin đã lưu bằng từ khóa hoặc ID. |
| `forget` | Đưa bộ nhớ vào trạng thái lưu trữ hoặc xóa một ghi nhận trong đó. |
| `learn` | Lưu sai sót, nguyên nhân và cách tránh lặp lại. |
| `briefing` | Đọc ngữ cảnh bộ nhớ hiện tại của dự án. |
| `task_state` | Đọc hoặc ghi mục tiêu, bước tiếp theo, trở ngại và công việc đã xong. |
| `message` | Tìm địa chỉ hội thoại; gửi, đọc hoặc xem tin nhắn có loại và trạng thái audit của nó. |
| `export` | Sao lưu bộ nhớ thành JSON. |
| `import` | Nhập bản sao lưu bộ nhớ. |
| `work_package` | Chuẩn bị bản tóm tắt bộ nhớ hoặc trích đoạn hội thoại có giới hạn để người dùng duyệt. |
| `user_patterns` | Tổng hợp thói quen làm việc. |
| `improvement` | Đề xuất cải tiến để người dùng duyệt. |

**Ghi chú dòng lệnh.**
- `memesh remember` lưu bộ nhớ vào dự án của thư mục hiện tại (giống `memesh learn`); `--project <tên>` chọn dự án khác, `--no-project` lưu mà không thuộc dự án nào.
- `memesh export -o backup.json` ký bản sao lưu bằng một khóa chỉ nằm trong thư mục MeMesh của bạn. `memesh import backup.json` chỉ tin cậy lại khi tệp không bị sửa và đến từ thư mục này; mọi tệp khác được nhập ở trạng thái không tin cậy (tìm được, không tự động chèn) và kết quả nói rõ điều đó. Bộ nhớ bạn đã quên (forget) vẫn giữ nguyên trạng thái lưu trữ: kết quả in ra đúng một lệnh để khôi phục (`--restore-archived`).
- `memesh message send` đọc nội dung từ `--payload-stdin`; không nhận nội dung qua argv.

---

Plugin Claude Code có **12 hook**; plugin Codex có thêm 2 hook dành riêng cho Codex. MeMesh không quét từ khóa trong tin nhắn của bạn; trợ lý tự quyết định dựa trên lời bạn nói. Bạn có thể sửa bộ nhớ qua MeMesh Mod trên Claude Code/Claude Desktop Code và trong MCP/biểu mẫu tích hợp sẵn trên Codex. Không có Web Dashboard độc lập.

**Xếp hạng theo điểm** — mức liên quan (30%) + độ mới (25%) + tần suất (18%) + độ tin cậy (17%) + tác động của việc truy xuất (10%). Xem [kiến trúc](docs/ARCHITECTURE.md).

## Quy tắc nhắn tin

- Giao diện hội thoại MCP/CLI chỉ có `discover`, `send`, `read`, `status`. Danh tính người gửi do host cung cấp; MCP nhận chuỗi `body`, CLI đọc nội dung từ stdin.
- Toàn bộ envelope đã render có giới hạn 8.000 byte UTF-8. Người nhận không xác định và tin quá lớn bị từ chối, có audit; người nhận đã đăng ký nhưng offline được đưa vào hàng đợi.
- Khi mở kho tin lần tiếp theo, maintenance xóa tin và sự kiện đã đủ 14 ngày, đồng thời tạo một thông báo cho tin còn đủ điều kiện mà chưa được giao sau một ngày. `queued` không có nghĩa đã giao, đã đọc, đã trả lời hoặc đã hoàn tất.
- `read` ghi nhận giao/đọc; `status` hiển thị audit và CLI `--json` xuất đầy đủ lịch sử của chủ sở hữu. HTTP cũ được giữ riêng; các trường project/poll/fetch/biên nhận của nó không áp dụng cho công cụ hội thoại mới. Xem [hướng dẫn nhắn tin](docs/platforms/agent-messaging.md).

</details>

[Giấy phép MIT](LICENSE)
