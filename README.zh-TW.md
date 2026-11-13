🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [Tiếng Việt](README.vi.md)

# MeMesh

**AI 程式開發 agent 的本機協作層。**

MeMesh 讓程式開發 AI 共用背景、交換任務與審查結果，並在不同對話間留下清楚的交接。共享記憶則保留你的偏好、專案決策和過去的教訓，讓你不必每次重新解釋。

- **已登記對話之間分工。** 交換任務、問題、審查請求與結果。目前新對話 hook 已接上 Claude；對應的 Codex 整合仍在開發中。
- **共用專案背景。** 同一台電腦上的 agent 可沿用專案決策和教訓，不必每次從頭了解。
- **留下清楚的交接。** 記錄目標、下一步與阻擋，供下一個對話確認後接續。
- **保留有用的記憶。** 儲存偏好、決策和教訓，讓不同對話與工具都能查找。決策、教訓和偏好在所有專案都找得到，並標明來自哪個專案；各專案的 commit 紀錄和對話摘要只留在原專案。

記憶預設存放在你電腦上的單一檔案：`~/.memesh/knowledge-graph.db`。MeMesh 不另跑 AI 模型。自動提醒依工具整合而定；交接提供背景，不代表任務一定會自動接續。

## 安裝

**Claude Code** — 在 Claude Code 輸入以下指令，完成後重新啟動：

```text
/plugin marketplace add PCIRCLE-AI/memesh
/plugin install memesh@pcircle-memesh
```

**Codex** — 在終端執行以下指令，完成後重新啟動 Codex：

```bash
codex plugin marketplace add PCIRCLE-AI/memesh
codex plugin add memesh@pcircle-memesh
```

**Hermes Agent** — 依 [MeMesh 記憶整合指南](docs/platforms/hermes-agent.md)連接 Hermes，即可使用記憶查找與擷取功能。

若也需要命令列工具，先安裝 [Node.js 22.16+](https://nodejs.org)，再執行：

```bash
npm install -g @pcircle/memesh
memesh doctor
```

[安裝與更新指南](llms-install.md) · [其他工具整合](docs/platforms/README.md)

若 `memesh doctor` 回報資料庫損毀，先關閉 AI 工具，再執行 `memesh repair`。它會保存核對過的損毀副本、救援可讀記憶，檢查新檔後才替換；系統 `sqlite3` 無法使用時會改用內建 Node 救援。也可用 `memesh repair --from-backup` 還原最新且通過檢查的記憶備份。完成後重新開啟 AI 工具。

`PCIRCLE-AI/memesh` 是提供 marketplace 的 GitHub 儲存庫；`memesh@pcircle-memesh` 表示從 `pcircle-memesh` marketplace 安裝 `memesh` 插件。

## 對話訊息（source 候選）

一個 session 實作，另一個審查、提問或回報結果。MeMesh 對話訊息只有四個動作：尋找地址、送出有類型的本文、讀取一則收件訊息，以及查看狀態／稽核；本文一律是不受信任資料。

1. 使用資料庫設定相同且已登記的對話。兩個插件皆已宣告 SessionStart／UserPromptSubmit 訊息 hook；Codex 格式的私有往返流程已驗，真正原生 host／模型交付仍待另驗。
2. 執行 `memesh message discover`，只使用確實列出的地址，不猜測收件者。
3. 只從 stdin 傳本文：`printf '%s' '請審查這項變更。' | memesh message send --recipient <address> --kind review_request --payload-stdin`。收件者用 `memesh message read --message-id <id>` 讀取，並可用 `--reply-to <id>` 回覆。

`queued` 不代表已送達、已讀、已回覆、已接受或已完成。原生叫醒與新對話跨機交付仍在開發中。

[設定、路由與收據詳情](docs/platforms/agent-messaging.md)

## 保留跨對話的背景

直接用平常說話的方式請 agent 幫忙：

> 記住這個專案使用 SQLite。
>
> 上次登入功能是怎麼決定的？
>
> 記下目前進度，方便下一個對話接手。

MeMesh 預設會記住。要移除某筆已存記憶，可請 agent 找出那筆記憶並執行 `forget`；一般對話仍照常保存。

Claude Code 插件提供自動記錄和提醒。Codex 插件在獲准執行 hooks 後，可以在對話開始時帶入記憶；其他自動記錄行為依工具而異。你也可以直接請 agent 儲存或查找記憶。

SessionStart／UserPromptSubmit、Claude Stop 與 Codex Bash 工具後的 hook 都會帶入完整待收訊息，成功輸出後才記錄交付。記憶 hooks 不再公布舊 principal 地址或舊收件指令；原生叫醒與模型收讀仍待驗。保留的 HTTP 協定另行處理。詳見[訊息指南](docs/platforms/agent-messaging.md)。

MeMesh 4.11.0 起在 Claude Code 新增 `/memesh-memories` 入口，可查看及修改專案記憶。Claude Desktop 在面板內編輯；終端 Claude Code 與 Codex 使用原生表單。Codex 可請 `$memesh` 查找並編輯記憶。只填要改的標題或段落，留白保留原文。儲存後讀回結果，取消不寫入；不支援的宿主仍可用原本的對話操作。

[完整工具與指令說明](docs/api/API_REFERENCE.md) · [Agent 訊息](docs/platforms/agent-messaging.md) · [運作方式](docs/ARCHITECTURE.md) · [參與開發](CONTRIBUTING.md)

<details>
<summary>工具與整合細節</summary>

## 全部 12 個記憶與協作工具

| 工具 | 用途 |
|------|------|
| `remember` | 儲存記憶（預設就會存，不必先說）；決策未附原因也照存。 |
| `recall` | 用關鍵字查找記憶，或用編號取回內容。 |
| `forget` | 封存記憶或移除其中一則觀察。 |
| `learn` | 記下錯誤、原因和避免重犯的方法。 |
| `briefing` | 讀取專案目前的記憶背景。 |
| `task_state` | 讀取或記錄目標、下一步、阻擋和完成事項。 |
| `message` | 尋找對話地址；送出、讀取或查看有類型對話訊息及其稽核狀態。 |
| `export` | 將記憶備份成 JSON。 |
| `import` | 匯入記憶備份。 |
| `work_package` | 準備有範圍限制的記憶摘要或對話摘錄，交由使用者審核。 |
| `user_patterns` | 整理工作習慣。 |
| `improvement` | 提出改善建議，交由使用者審核。 |

**命令列補充。**
- `memesh remember` 會把新記憶歸到目前資料夾的專案（和 `memesh learn` 相同）；`--project <名稱>` 指定其他專案，`--no-project` 存成不屬於任何專案。追加既有無專案記憶時，若未明確指定專案或專案標籤，仍維持無專案；省略 `--type` 會沿用既有類型。
- `memesh export -o backup.json` 會用只留在 MeMesh 資料夾裡的密鑰替備份簽章。`memesh import backup.json` 只在檔案沒被改過、且來自這個資料夾時才恢復信任；其他檔案一律以不受信任匯入（可搜尋、不會自動注入），輸出會說明。你忘記（forget）的記憶仍保持封存：輸出會印出一行能復原的指令（`--restore-archived`）。
- `memesh message send` 從 `--payload-stdin` 讀取本文；不接受把本文放進 argv。

---

Claude Code 插件共有 12 個 hook 指令；Codex 插件另有 2 個 Codex 專用的 hook。MeMesh 不掃描你的話判斷儲存意圖，由 agent 依你的話自己判斷。每個 session 開場帶入有上限的記憶全貌與近期使用者對話標題；提問命中已存記憶時，最多兩筆記憶的內容會一起帶入，整段連同資料提示與 `[mem:id]` 編號合計不超過 4 KiB（UTF-8）。開場標題不代表內容已讀；內容超量會明示截取，附上可用 `recall` 讀取的編號。標題含 pending、blocked 或等待也可取回。提問帶入可用 `memesh config set promptRecall false` 關閉。
記憶介面在 Claude Code／Claude Desktop Code 使用 MeMesh Mod，Codex 使用 MCP／原生表單；不再提供獨立 Web Dashboard。

排序權重：相關性 30%、新近程度 25%、使用頻率 18%、信心 17%、回憶影響 10%。詳見[架構說明](docs/ARCHITECTURE.md)。

## 細節

- MCP／CLI 對話介面只有 `discover`、`send`、`read`、`status`。寄件身分來自 host；MCP 以 `body` 傳文字，CLI 從 stdin 讀取。
- 完整 rendered envelope 上限為 8,000 UTF-8 bytes。未知收件者與超量訊息會拒絕並留下稽核紀錄；已登記但離線的收件者會排隊。
- 下次開啟訊息庫時，維護會清除已滿 14 天的訊息與事件，並對仍符合條件、滿一天未交付的訊息建立一次通知。`queued` 不代表已交付、已讀、已回覆或已完成。
- `read` 記錄交付／已讀；`status` 顯示稽核，CLI 的 `--json` 可輸出完整擁有者紀錄。舊 HTTP 協定另外保留；其 project／poll／fetch／收據欄位不適用於新對話工具。見[訊息指南](docs/platforms/agent-messaging.md)。

</details>

[MIT 授權](LICENSE)
