🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [Tiếng Việt](README.vi.md)

# MeMesh

**Lớp cộng tác cục bộ dành cho các trợ lý lập trình AI.**

MeMesh giúp các trợ lý lập trình AI chia sẻ ngữ cảnh, trao đổi công việc, góp ý cho nhau và bàn giao rõ ràng giữa các phiên. Bộ nhớ dùng chung giữ lại sở thích, quyết định của dự án và kinh nghiệm đã tích lũy, để bạn không phải giải thích lại từ đầu mỗi lần mở phiên mới.

- **Phân công giữa các phiên.** Các phiên Codex và Claude Code đang chạy có thể trao đổi công việc, câu hỏi, yêu cầu rà soát và kết quả qua hệ thống nhắn tin MeMesh và Claude Channel tùy chọn.
- **Dùng chung ngữ cảnh dự án.** Các trợ lý trên cùng một máy có thể tra lại quyết định và kinh nghiệm của dự án, thay vì tìm hiểu lại từ đầu.
- **Bàn giao rõ ràng.** Ghi lại mục tiêu, bước tiếp theo và vướng mắc để phiên sau kiểm tra trước khi tiếp tục.
- **Giữ lại những điều hữu ích.** Lưu sở thích, quyết định và bài học để tìm lại trong các phiên và công cụ khác nhau.

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

Nếu cần dùng cả công cụ dòng lệnh, hãy cài [Node.js 22.13+](https://nodejs.org), rồi chạy:

```bash
npm install -g @pcircle/memesh
memesh doctor
```

[Hướng dẫn cài đặt và cập nhật](llms-install.md) · [Các tích hợp khác](docs/platforms/README.md)

`PCIRCLE-AI/memesh` là kho GitHub cung cấp marketplace. `memesh@pcircle-memesh` chọn plugin `memesh` từ marketplace `pcircle-memesh`.

## Cho Codex và Claude Code phối hợp

Dùng một phiên để triển khai thay đổi, một phiên khác để rà soát, đặt câu hỏi hoặc báo cáo kết quả. MeMesh cung cấp hộp thư cục bộ dùng chung; Claude Channel đưa tin nhắn trực tiếp vào phiên Claude Code đang chạy. Codex dùng cơ chế thông báo native riêng, sau đó lấy nội dung tin nhắn từ hộp thư.

1. Cài các plugin ở trên và mở cả hai công cụ trong cùng kho mã, bằng cùng người dùng hệ điều hành và cùng cấu hình cơ sở dữ liệu MeMesh.
2. Phiên Claude MCP thông thường đủ điều kiện có thể nhận thông báo native không cần Channel trên macOS/Linux; [Claude Channel](docs/platforms/agent-messaging.md#claude-channel-runner) tùy chọn gửi toàn bộ envelope. Phiên Codex CLI đủ điều kiện tự đăng ký khi hook SessionStart chạy.
3. Yêu cầu trợ lý: “Dùng `message discover` để tìm phiên Claude/Codex đang chạy cho dự án này, gửi yêu cầu rà soát và báo lại phản hồi.” Chọn người nhận thực sự xuất hiện trong kết quả; không đoán ID phiên. Bên nhận đọc tin, ghi nhận `intake`, rồi trả lời với kết quả rà soát.

Khi chưa bật Claude Channel, hộp thư lưu trữ bền vững và nhắc nhở qua hook của Claude Code vẫn dùng được. Gửi thành công không có nghĩa bên kia đã nhận làm hay hoàn thành công việc. Phiên đã dừng không tự tiếp tục; hãy kiểm tra phiên Codex Desktop bằng `message discover`, thay vì mặc định rằng nó đã tham gia. Kênh cục bộ này không chuyển tiếp tin nhắn giữa các máy tính.

[Chi tiết thiết lập, định tuyến và biên nhận](docs/platforms/agent-messaging.md)

## Giữ lại ngữ cảnh cho phiên sau

Yêu cầu trợ lý bằng ngôn ngữ tự nhiên:

> Hãy nhớ rằng dự án này dùng SQLite.
>
> Lần trước chúng ta đã quyết định gì về đăng nhập?
>
> Lưu tiến độ hiện tại để phiên tiếp theo có thể tiếp tục.

Plugin Claude Code cung cấp tính năng ghi nhận và nhắc nhở tự động. Plugin Codex có thể đưa ngữ cảnh vào đầu phiên khi được phép chạy các hook; những hành vi ghi nhận khác tùy thuộc công cụ. Bạn cũng có thể yêu cầu trợ lý lưu hoặc tìm bộ nhớ trực tiếp.

Nhắc nhở hộp thư trong Claude Code không cần thiết lập Channel: khi chưa cấu hình danh tính riêng, các hook dùng người nhận cục bộ `claude-code`. Chúng kiểm tra khi khởi động, khi bạn gửi lời nhắc tiếp theo và khi kết thúc lượt; nhắc nhở dừng khi trợ lý ghi nhận `intake` cho tin nhắn đó. Đẩy tin trực tiếp qua Channel là tùy chọn; xem [hướng dẫn nhắn tin](docs/platforms/agent-messaging.md#claude-channel-runner).

Các phiên MCP Claude Code thông thường tự đăng ký trong `message discover` mà không cần bật Channel. Khi socket hộp thư native khả dụng, phiên nhận thông báo rồi lấy nội dung; nếu không, hộp thư bền vững và nhắc nhở qua hook vẫn hoạt động. Trực tuyến không chứng minh thông báo đã đến.

Các bản dựng từ mã nguồn chưa phát hành bổ sung `/memesh-memories` trong Claude Code để xem và sửa bộ nhớ dự án. Claude Desktop sửa ngay trong bảng; Claude Code trên terminal và Codex dùng biểu mẫu tích hợp sẵn. Trong Codex, yêu cầu `$memesh` tìm và sửa một bộ nhớ. Chỉ điền tiêu đề hoặc đoạn cần đổi, để trống các trường khác để giữ nguyên. Lưu sẽ đọc lại kết quả đã ghi; Hủy không ghi gì. Công cụ chưa hỗ trợ vẫn dùng quy trình hội thoại hiện có.

[Tham chiếu công cụ và lệnh](docs/api/API_REFERENCE.md) · [Nhắn tin giữa các trợ lý](docs/platforms/agent-messaging.md) · [Cách hoạt động](docs/ARCHITECTURE.md) · [Đóng góp](CONTRIBUTING.md)

<details>
<summary>Chi tiết công cụ và tích hợp</summary>

## Toàn bộ 12 công cụ bộ nhớ và phối hợp

| Công cụ | Chức năng |
|---------|-----------|
| `remember` | Lưu bộ nhớ; quyết định cần có lý do. |
| `recall` | Tìm bộ nhớ. |
| `forget` | Đưa bộ nhớ vào trạng thái lưu trữ hoặc xóa một ghi nhận trong đó. |
| `learn` | Lưu sai sót, nguyên nhân và cách tránh lặp lại. |
| `briefing` | Đọc ngữ cảnh bộ nhớ hiện tại của dự án. |
| `task_state` | Đọc hoặc ghi mục tiêu, bước tiếp theo, trở ngại và công việc đã xong. |
| `message` | Tìm các trợ lý cục bộ đang chạy và trao đổi tin nhắn. |
| `export` | Sao lưu bộ nhớ thành JSON. |
| `import` | Nhập bản sao lưu bộ nhớ. |
| `work_package` | Chuẩn bị bản tóm tắt bộ nhớ hoặc trích đoạn hội thoại có giới hạn để người dùng duyệt. |
| `user_patterns` | Tổng hợp thói quen làm việc. |
| `improvement` | Đề xuất cải tiến để người dùng duyệt. |

---

Các plugin có **10 hook**. Tính năng nhắc khi người dùng muốn ghi nhớ điều gì đó hỗ trợ 5 ngôn ngữ. Bạn có thể sửa bộ nhớ qua MeMesh Mod trên Claude Code/Claude Desktop Code và trong MCP/biểu mẫu tích hợp sẵn trên Codex. Không có Web Dashboard độc lập.

**Xếp hạng theo điểm** — mức liên quan (30%) + độ mới (25%) + tần suất (18%) + độ tin cậy (17%) + tác động của việc truy xuất (10%). Xem [kiến trúc](docs/ARCHITECTURE.md).

## Quy tắc nhắn tin

Hướng dẫn đầy đủ: [docs/platforms/agent-messaging.md](docs/platforms/agent-messaging.md).

- Qua MCP, HTTP hoặc CLI, bạn có thể gửi một payload JSON tối đa 65.536 byte UTF-8 (64 KiB) đến một người nhận cụ thể trên cùng máy. Tin nhắn được lưu lại để bên nhận lấy nội dung sau; sau khi khởi động lại, bên nhận có thể tiếp tục đọc bằng con trỏ. Nội dung tin nhắn là dữ liệu đầu vào, không phải chỉ dẫn được mặc nhiên tin cậy. Các trạng thái tiếp nhận (`intake`), xác nhận (`ack`), xử lý công việc (`disposition`) và kích hoạt công cụ (`activation`) được ghi riêng.
- Khi plugin MeMesh Codex được bật, mỗi luồng Codex CLI thông thường mới khởi động hoặc tiếp tục, có danh tính luồng hợp lệ và thư mục làm việc tồn tại, sẽ tự đăng ký bằng danh tính riêng cho luồng. Không cần chạy `agent setup` thủ công. SessionStart khởi chạy một tiến trình đồng hành riêng cho người dùng. SessionEnd giữ cửa sổ hàng đợi nhàn rỗi tối đa 45 giây; khi tiếp tục, thế hệ kết nối trước được thay thế; hết hạn thì đăng ký bị xóa. Tin được hàng đợi nhận trong cửa sổ này chỉ hiện thành thông báo ngắn khi cùng luồng tiếp tục, rồi trợ lý lấy nội dung từ hộp thư; điều đó không có nghĩa giao diện đã dừng được đánh thức. `memesh agent setup codex-session` chỉ cần khi một workspace muốn dùng một tên người nhận cố định.
- Toàn bộ `native envelope` (gói tin gồm thông tin định tuyến và payload) có giới hạn riêng 16.384 byte (16 KiB). Gửi tới một phiên cụ thể chỉ thành công khi hàng đợi native chấp nhận. Gói tin quá lớn trả về `native_message_too_large`; không kết nối được router cục bộ trả về `router_unreachable`; phiên không khả dụng hoặc từ chối trả về `recipient_unavailable`. Dữ liệu phục hồi theo đúng phạm vi vẫn được giữ trong cả ba trường hợp. Gửi tới danh tính ổn định (`principal`) vẫn hỗ trợ lưu rồi chuyển tiếp. Việc cơ chế native chấp nhận tin nhắn không đồng nghĩa xác nhận hay hoàn tất công việc; không đưa thông tin bí mật vào tin nhắn native.
- Phiên Codex đã dừng, mất kết nối hoặc không tồn tại không được đánh thức hay thay bằng phiên khác. Lần gửi qua cơ chế native thất bại tới phiên cụ thể không tự phát lại; bên gửi phải chủ động thử lại. `memesh message storage report` cho biết dữ liệu đang lưu. Cơ chế native chỉ hỗ trợ macOS và Linux.
- Cơ chế native được mô tả ở đây dành cho Codex CLI thông thường. Không mặc định Codex Desktop hoặc tác vụ chưa kết nối đã đăng ký: hãy kiểm tra đúng phiên đang chạy trong `message discover`. Đây là giới hạn của những gì đã được kiểm chứng, không phải khẳng định các công cụ đó luôn không tương thích.
- Claude Channel và Codex tự đăng ký không cần sao chép giá trị `--project` giữa hai bên. Mỗi công cụ suy ra dự án định tuyến từ thư mục làm việc của Claude hoặc `--workspace` của Codex, nên khởi chạy cả hai trong cùng kho mã sẽ đưa chúng vào cùng dự án.

</details>

[Giấy phép MIT](LICENSE)
