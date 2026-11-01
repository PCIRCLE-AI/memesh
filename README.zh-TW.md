🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [Tiếng Việt](README.vi.md)

# MeMesh

**AI 程式開發 agent 的本機協作層。**

MeMesh 讓程式開發 AI 共用背景、交換任務與審查結果，並在不同對話間留下清楚的交接。共享記憶則保留你的偏好、專案決策和過去的教訓，讓你不必每次重新解釋。

- **跨對話分工。** 正在執行的 Codex 和 Claude Code session 可透過 MeMesh 訊息與選配的 Claude Channel 交換任務、問題、審查請求和結果。
- **共用專案背景。** 同一台電腦上的 agent 可沿用專案決策和教訓，不必每次從頭了解。
- **留下清楚的交接。** 記錄目標、下一步與阻擋，供下一個對話確認後接續。
- **保留有用的記憶。** 儲存偏好、決策和教訓，讓不同對話與工具都能查找。

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

若也需要命令列工具，先安裝 [Node.js 22.13+](https://nodejs.org)，再執行：

```bash
npm install -g @pcircle/memesh
memesh doctor
```

[安裝與更新指南](llms-install.md) · [其他工具整合](docs/platforms/README.md)

`PCIRCLE-AI/memesh` 是提供 marketplace 的 GitHub 儲存庫；`memesh@pcircle-memesh` 表示從 `pcircle-memesh` marketplace 安裝 `memesh` 插件。

## 讓 Codex 和 Claude Code 協作

一個 session 實作，另一個審查、提問或回報結果。MeMesh 提供共用的本機訊息收件匣；Claude Channel 可將訊息即時送進正在執行的 Claude Code session。Codex 使用自己的原生通知路徑，再擷取訊息正文。

1. 安裝上方插件，以相同作業系統使用者、相同 MeMesh 資料庫設定，在同一個 repository 啟動兩個工具。
2. 符合條件的一般 Claude MCP 對話可在 macOS／Linux 不開 Channel 接收原生通知；選配的 [Claude Channel](docs/platforms/agent-messaging.md#claude-channel-runner) 可傳遞完整封套。一般 Codex CLI session 在插件 SessionStart hook 執行時自動註冊。
3. 請 agent：「用 `message discover` 找到這個專案正在執行的 Claude／Codex session，送出審查請求，並回報對方回覆。」使用實際查到的收件者，不猜 session ID。接收方讀取訊息、記錄 `intake`，再回覆審查結果。

未啟用 Claude Channel 時，仍可使用持久收件匣與 Claude Code hook 提醒。送達不代表對方已接下或完成工作；已停止的 session 不會自動恢復。Codex Desktop 是否參與，須以 `message discover` 查到的實際 session 為準。本機 channel 不負責跨電腦傳遞訊息。

[設定、路由與收據詳情](docs/platforms/agent-messaging.md)

## 保留跨對話的背景

直接用平常說話的方式請 agent 幫忙：

> 記住這個專案使用 SQLite。
>
> 上次登入功能是怎麼決定的？
>
> 記下目前進度，方便下一個對話接手。

Claude Code 插件提供自動記錄和提醒。Codex 插件在獲准執行 hooks 後，可以在對話開始時帶入記憶；其他自動記錄行為依工具而異。你也可以直接請 agent 儲存或查找記憶。

Claude Code 的收件提醒不需設定 Channel：沒有自訂身分時，hooks 使用本機 `claude-code` 收件者，在啟動、下一次輸入與回合結束時檢查；agent 為該訊息登記 `intake` 後便停止提醒。Channel 即時推送是選配，詳見[訊息指南](docs/platforms/agent-messaging.md#claude-channel-runner)。

一般 Claude Code MCP 對話會自動登記到 `message discover`，不需啟用 Channel。原生收訊 socket 可用時可收到通知，再擷取正文；否則仍可使用持久收件匣與 hook 提醒。上線本身不證明通知已送達。

尚未發布的原始碼版本新增 Claude Code `/memesh-memories` 入口，可查看及修改專案記憶。Claude Desktop 在面板內編輯；終端 Claude Code 與 Codex 使用原生表單。Codex 可請 `$memesh` 查找並編輯記憶。只填要改的標題或段落，留白保留原文。儲存後讀回結果，取消不寫入；不支援的宿主仍可用原本的對話操作。

[完整工具與指令說明](docs/api/API_REFERENCE.md) · [Agent 訊息](docs/platforms/agent-messaging.md) · [運作方式](docs/ARCHITECTURE.md) · [參與開發](CONTRIBUTING.md)

<details>
<summary>工具與整合細節</summary>

## 全部 12 個記憶與協作工具

| 工具 | 用途 |
|------|------|
| `remember` | 儲存記憶；決策需要附上原因。 |
| `recall` | 用關鍵字查找記憶，或用編號取回內容。 |
| `forget` | 封存記憶或移除其中一則觀察。 |
| `learn` | 記下錯誤、原因和避免重犯的方法。 |
| `briefing` | 讀取專案目前的記憶背景。 |
| `task_state` | 讀取或記錄目標、下一步、阻擋和完成事項。 |
| `message` | 找到正在執行的本機 agent 並交換訊息。 |
| `export` | 將記憶備份成 JSON。 |
| `import` | 匯入記憶備份。 |
| `work_package` | 準備有範圍限制的記憶摘要或對話摘錄，交由使用者審核。 |
| `user_patterns` | 整理工作習慣。 |
| `improvement` | 提出改善建議，交由使用者審核。 |

---

插件共有 10 個 hook 指令。「記住這件事」提醒支援 5 種語言。
記憶介面在 Claude Code／Claude Desktop Code 使用 MeMesh Mod，Codex 使用 MCP／原生表單；不再提供獨立 Web Dashboard。

排序權重：相關性 30%、新近程度 25%、使用頻率 18%、信心 17%、回憶影響 10%。詳見[架構說明](docs/ARCHITECTURE.md)。

## 細節

**agent 訊息的完整規則**（完整說明：[docs/platforms/agent-messaging.md](docs/platforms/agent-messaging.md)）：

- 今天就能做的：MCP、HTTP 或 CLI sender 可把一份 JSON 編碼後不超過 65,536 UTF-8 bytes（64 KiB）的不受信任 payload 耐久化送給一個指定的本機 recipient。接收端可另行擷取、在重啟後用 opaque cursor 補收，並把 intake、acknowledgement、workflow disposition 與 host activation 分開記錄。
- 啟用 MeMesh Codex plugin 後，每個具有有效 thread identity 與現有工作目錄、並新啟動或恢復的一般 Codex CLI thread，都會自動以 thread-scoped identity 註冊，不需要手動執行 `agent setup`。SessionStart 會啟動 owner-private companion；SessionEnd 保留 45 秒的有限 idle queue 視窗，resume 會取代前一個 exact generation，逾時則移除 registration。在 idle 視窗內被 queue 接受的訊息，會在同一 thread resume 時以簡短通知出現，agent 再從 inbox 擷取正文；這不代表已停止的 UI 被自動喚醒。只有某個 workspace 需要穩定的命名 principal 時，才需選用 `memesh agent setup codex-session`。包含 routing metadata 與 payload 的完整 native envelope 另有 16,384 bytes（16 KiB）上限。exact-session send 只有在原生 queue 接受後才成功；完整 envelope 過大時回報 `native_message_too_large`，sender 無法連到本機 router 時回報 `router_unreachable`，其他無法使用或拒絕的 session 則回報 `recipient_unavailable`。不論 sender 或 recipient 失敗，scope 相符的 recovery data 仍會保留，Principal target 在無法原生傳遞時仍保有 durable store-and-forward。原生接受不代表 acknowledgement 或 workflow disposition，原生訊息不得包含 secrets。
- 已停止、缺失或斷線的 Codex session 不會被喚醒，也不會被別的對話頂替；失敗的 exact-session 原生傳遞不會自動重播，sender 必須明確重試。scope 相符的 recovery data 仍會保留，`memesh message storage report` 可以看目前存了什麼。原生傳遞目前只支援 macOS 和 Linux。
- 這條文件化的原生路徑涵蓋一般 Codex CLI。除非確切且正在執行的 session 出現在 `message discover`，否則不要假設 Codex Desktop 或未連接的 task 已註冊；這是證據邊界，不代表這些 host 一律不相容。
- Claude Channel 與自動註冊的 Codex 配對時，不需要在兩邊之間複製 `--project` 值：各 host 從自己的工作目錄（Claude）或 `--workspace`（Codex）推得自己的 routing project，所以在同一個 repository 啟動兩者，就會自動落在同一個 project。

</details>

[MIT 授權](LICENSE)
