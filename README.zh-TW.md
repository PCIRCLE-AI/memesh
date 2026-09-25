🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [Deutsch](README.de.md)

<p align="center">
  <h1 align="center">MeMesh</h1>
  <p align="center">
    <strong>讓 AI 寫程式代理在本機共用記憶並協作。</strong><br />
    一個 SQLite 檔案。不用 Docker，不用雲端。
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@pcircle/memesh"><img src="https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=3b82f6&label=npm" alt="npm" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="MIT" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.13.0-22c55e?style=flat-square" alt="Node" /></a>
    <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-a855f7?style=flat-square" alt="MCP" /></a>
  </p>
</p>

---

## 它能做什麼

換了 session 或寫程式代理（agent）後，你可能得重述先前的決策、解釋同一套架構，或重新找出已修過的問題。

MeMesh 讓代理在本機共用記憶與交換訊息。主要用途是跨 session 保存你的偏好、決策與經驗；在代理間傳送派工、問題、進度與結果；留下工作交接，讓後續 session 有脈絡可查。Claude Code 和 Codex 是主要例子；Cursor 與其他 MCP 用戶端也能透過文件列出的整合方式使用。自動擷取與傳遞能力取決於下方的 host 整合。

```
   you work with the agent
            |
            v
   +------------------+      +------------------+
   |  Claude Code     |      |  Claude Code     |
   |  capture         |      |  recall          |
   |  sessions,       | ---> |  at session      |
   |  commits, fixes  |      |  start and       |
   |  (automatic)     |      |  before edits    |
   +------------------+      +------------------+
            |                         ^
            v                         |
   +----------------------------------------+
   |  ~/.memesh/knowledge-graph.db           |
   |  decisions, lessons, links between them |
   +----------------------------------------+
```

左邊是自動記錄（對話、commit、修掉的錯誤），右邊是適時提醒（開新對話時、改檔案之前），中間是存放決定、教訓與關聯的那個檔案。

- **在適當時機記錄、提醒與防護。** MeMesh 的 Claude Code 與 Codex 整合共提供 **9 個 hook command**：其中 8 個 Claude Code hook 分別在開新對話、改檔案前、`git commit` 後、計畫核准或你回答問題後、Claude 停下來時、對話被壓縮前、你說「記下來」時（聽得懂 5 種語言），以及執行可能重犯已接受教訓的危險指令前運作。計畫/問題與「記下來」hook 只會提醒 agent 呼叫 `remember`；第 9 個 command 同時處理 Codex SessionStart 與 SessionEnd，註冊並退場符合資格的一般 Codex CLI session。
- **所有工具共用一份記憶。** 今天在 Claude Code 存的決定，明天 Codex 或 Cursor 也用得到。
- **agent 之間可以留言。** 本機的耐久收件匣可跨重啟保存；在 macOS 或 Linux 上，確切且活動中的一般 Codex CLI session 裝有 MeMesh plugin 時，也能透過原生 queue 收到有界訊息。
- **留下工作交接。** Claude Code 可把最後一則有實質內容的回覆留給同一專案的下個 session。用 `task_state` 記錄已明確說出的目標、下一步、阻礙或完成項目，再用 `message` 將證據位置或待處理問題送給確切收件者。
- **有儀表板** 可以瀏覽全部內容：4 個分頁、11 種語言，在 `http://localhost:3737/dashboard`。

---

## 支援哪些平台

| 平台 | 怎麼接 | 說明 |
|---|---|---|
| Claude Code | plugin：hook、MCP 工具、`/memesh` skill | 自動記錄與提醒都有 |
| Codex CLI | Plugin，或 MCP server（`memesh-mcp`） | 零設定 plugin 安裝，或 `codex mcp add memesh -- memesh-mcp` |
| Gemini CLI | MCP server（`memesh-mcp`） | `gemini mcp add -s user memesh memesh-mcp` |
| Cursor、Cline 與其他 MCP 用戶端 | MCP server（`memesh-mcp`） | 把用戶端指向 `memesh-mcp` |
| Hermes Agent | 原生記憶 plugin | [docs/platforms/hermes-agent.md](docs/platforms/hermes-agent.md) |
| OpenClaw | 原生記憶 plugin | 只有原始碼，尚未發佈或完成真實環境測試：[docs/platforms/openclaw.md](docs/platforms/openclaw.md) |
| 你自己的程式或腳本 | `memesh serve` 提供的 HTTP API | [docs/platforms/universal.md](docs/platforms/universal.md) |
| ChatGPT、Gemini 網頁版等線上聊天 | 透過你自己架的本機橋接走 HTTP API | [docs/platforms/README.md](docs/platforms/README.md) |

Claude Code 的 8 個 hook 提供自動記錄、回想、提醒與防護。Codex plugin 會載入同一份 hook 設定：在 Codex 允許執行這個 plugin 的 hook 之後，它的 SessionStart hook 會注入同樣的記憶區塊，並為符合資格的一般 CLI thread 啟動傳訊 companion。其他 hook 在 Codex 下是否會執行，目前尚未驗證。使用 Codex plugin 時，只有在沒看到這個區塊時才呼叫 `briefing`；只有 MCP 的用戶端請在 session 開始時呼叫 `briefing`。需要特定資訊時再呼叫 `recall`。

回想與擷取維持本機且可預測：SQLite FTS5 搜尋、明確的記憶工具與規則式 hooks。這個版本不設定也不呼叫 LLM、embedding 或 vector provider。舊版留下的 provider 設定仍保留在磁碟上但會被忽略；`memesh doctor` 只會列出頂層欄位名稱，不會讀取或印出它們的值。

---

## 怎麼安裝

Plugin 與 npm-global CLI 共用同一個資料庫。Claude Code 使用者通常同時安裝 Claude plugin 與 CLI；Codex 可使用自己的 plugin，或使用 CLI 提供的 MCP server。

```
   Claude Code chat                Terminal, Codex, Cursor
         |                                  |
         v                                  v
   +-----------------+              +------------------+
   | A: plugin       |              | B: npm global    |
   | /plugin install |              | npm install -g   |
   | hooks + tools   |              | memesh CLI       |
   | + /memesh skill |              | + memesh-mcp     |
   +-----------------+              +------------------+
         |                                  |
         +---------------+------------------+
                         v
            ~/.memesh/knowledge-graph.db
               (one file, both paths)
```

**A. 在 Claude Code 裡裝**（hook、工具和 `/memesh` skill 會自動設定好）：

```
/plugin marketplace add PCIRCLE-AI/memesh
/plugin install memesh@pcircle-memesh
```

重開 Claude Code。下次對話開頭會出現 `◉ MeMesh`。

**B. 在終端機裝**（需要 [Node 22.13 以上](https://nodejs.org)）：

```bash
npm install -g @pcircle/memesh
memesh doctor          # 檢查本機安裝健康狀態並列出修復方式
memesh install-hooks   # 沒裝 A 才需要：幫 Claude Code 接上 hook，不動你原本的設定
```

Codex 零設定安裝：執行 `codex plugin marketplace add PCIRCLE-AI/memesh` 與 `codex plugin add memesh@pcircle-memesh`。手動替代方案是 `codex mcp add memesh -- memesh-mcp`。Cursor：把 `{ "mcpServers": { "memesh": { "command": "memesh-mcp" } } }` 加進 `~/.cursor/mcp.json`。Dashboard 的 doctor 提醒可執行它能驗證的兩種可復原本機修復；單純開啟頁面不會自動改檔案。

> **裝了 plugin 不等於有 `memesh` 指令。** `/plugin install` 之後，在終端機打 `memesh` 會出現 `command not found`，要再跑 `npm install -g @pcircle/memesh` 才會有。只在 Claude Code 對話裡用的話，裝 A 就夠了。

**更新：** Claude Code plugin 用 `memesh upgrade-plugin`（沒有 CLI 時可用 `npx @pcircle/memesh upgrade-plugin`）；Codex plugin 用 `codex plugin marketplace upgrade pcircle-memesh && codex plugin add memesh@pcircle-memesh`；npm-global CLI 用 `memesh update`。**想讓 AI 幫你裝？** 把 [llms-install.md](llms-install.md) 丟給它。

---

## 怎麼開始

```bash
memesh remember "登入功能用 OAuth 2.0 加 PKCE"
memesh recall "登入"
# -> 找到那筆 PKCE 的決定

memesh briefing        # agent 對這個專案知道多少
memesh serve           # 啟動本機 server 並印出儀表板網址
```

讓 `memesh serve` 保持執行，再開啟它印出的網址。在 Claude Code 裡使用記憶工具時連終端機都不用開：在對話裡說「記下來」就好；有內容可看之後，開新對話時也會自動先收到摘要。

有了記憶之後，兩件值得知道的事：

- `forget` 是把整筆記憶封存，不是刪掉。新的記憶可以蓋過舊的。
- 執行中的 agent 可呼叫 `work_package`，準備一份日曆摘要，或從最新且符合資格的近期 Claude Code transcript 取得有界限的可見輪次。Transcript 模式要求 client 提供唯一符合的 MCP file root；root 缺失或不明確，以及有界掃描失敗時都會封閉失敗。提交會保留遮蔽後的來源輪次，且只暫存為待人工審核提案；agent 不能自行套用或拒絕，MeMesh 也不會呼叫 provider。確切的探索上限請見 [API reference](docs/api/API_REFERENCE.md#work_package)。

交接時，Claude Code 的 Stop hook 會把最後一則有實質內容的回覆存成可替換的專案筆記。近期且受信任的筆記會在下個 Claude Code session 和任何用戶端的 `briefing` 中排在其他記憶之前；它只是供核對的提示，不能保證工作自動接續。只用 `task_state` 記錄確實知道的工作狀態，並用 `message` 將證據位置或待處理問題送給確切收件者（[代理訊息指南](docs/platforms/agent-messaging.md)）。訊息可供後續補收，但傳遞、擷取或原生 queue 接受都不代表對方完成工作。

`briefing` 會優先顯示專案最近的決策，並另外選取最多五則專案教訓。交接筆記、顯示的任務狀態、排序後的記憶、`full` 層級的全域記憶，以及注入的索引，共用一個 4000 字元的記憶區塊上限。索引若提示還有未列出的記憶，請用 `recall`；`memesh briefing --index` 的獨立索引仍採用自己的 40 行／3072 位元組上限。

完整指令與工具說明：[docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md)。架構：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。參與開發：[CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 全部 12 個記憶與協作工具

| 工具 | 做什麼 |
|------|--------|
| `work_package` | 準備一份有界限且不受信任的日曆摘要，或從唯一符合的 MCP workspace root 準備 Claude Code transcript 套件；提交一份嚴格結果等待人工審核，或延後而不產生耐久變更。Transcript 提交會保留有界且已遮蔽的來源輪次；不會暴露檔案路徑、隱藏推理、provider、embedding 或 vector 資料。 |
| `remember` | 用觀察、關係和標籤儲存知識；也可以只給一段自由文字（`note`），標題、觀察和名稱會自動推導出來；`replace` 則是直接改掉既有的那一筆 |
| `recall` | 本機 FTS5 搜尋，包含多因素評分（相關性、近期性、頻率、信心、回憶影響） |
| `forget` | 軟歸檔（永不刪除）或移除特定觀察 |
| `export` | 以 JSON 備份、搬遷記憶，或在相容代理之間轉移 |
| `import` | 匯入記憶，包含合併策略（跳過 / 覆寫 / 追加） |
| `learn` | 記錄來自錯誤的結構化教訓（錯誤、根本原因、修復、預防） |
| `task_state` | 讀取或記下工作進度——目標、下一步、卡住的地方、剛完成的事 |
| `briefing` | 提供給任何 MCP client 的工作拓撲——符合條件的專案交接筆記會在所有層級排在其他記憶之前；`minimal` 接著顯示本專案的決定、教訓、已知事實與近期活動，`standard` 加上新鮮任務狀態和有界記憶索引，`full` 再加入其他專案與全域記憶；確切的 `project` + `recipient` 才會顯示該收件者尚未擷取的訊息 |
| `user_patterns` | 分析你的工作模式——時間表、工具、優勢、學習領域 |
| `improvement` | 將有證據來源的產品改善送交人類審核，或讀取其狀態；agent 不能自行接受或拒絕 |
| `message` | 先找出活動 agent，再交換確切收件者的不受信任訊息。Durable JSON payload 上限 64 KiB；完整 native envelope 上限 16 KiB，並區分 `native_message_too_large` 與 `recipient_unavailable`。原生接受、探索、輪詢與擷取都不代表 ACK 或 workflow disposition |

---

## 細節

**評分排序** — 結果依相關性（30%）+ 近期性（25%）+ 頻率（18%）+ 信心（17%）+ 回想影響（10%）排序。

**agent 訊息的完整規則**（完整說明：[docs/platforms/agent-messaging.md](docs/platforms/agent-messaging.md)）：

- 今天就能做的：MCP、HTTP 或 CLI sender 可把一份 JSON 編碼後不超過 65,536 UTF-8 bytes（64 KiB）的不受信任 payload 耐久化送給一個指定的本機 recipient。接收端可另行擷取、在重啟後用 opaque cursor 補收，並把 intake、acknowledgement、workflow disposition 與 host activation 分開記錄。
- 啟用 MeMesh Codex plugin 後，每個具有有效 thread identity 與現有工作目錄、並新啟動或恢復的一般 Codex CLI thread，都會自動以 thread-scoped identity 註冊，不需要手動執行 `agent setup`。SessionStart 會啟動 owner-private companion；SessionEnd 保留 45 秒的有限 idle queue 視窗，resume 會取代前一個 exact generation，逾時則移除 registration。在 idle 視窗內被 queue 接受的訊息，會在同一 thread resume 時進入模型；這不代表已停止的 UI 被自動喚醒。只有某個 workspace 需要穩定的命名 principal 時，才需選用 `memesh agent setup codex-session`。包含 routing metadata 與 payload 的完整 native envelope 另有 16,384 bytes（16 KiB）上限。exact-session send 只有在原生 queue 接受後才成功；完整 envelope 過大時回報 `native_message_too_large`，sender 無法連到本機 router 時回報 `router_unreachable`，其他無法使用或拒絕的 session 則回報 `recipient_unavailable`。不論 sender 或 recipient 失敗，scope 相符的 recovery data 仍會保留，Principal target 在無法原生傳遞時仍保有 durable store-and-forward。原生接受不代表 acknowledgement 或 workflow disposition，原生訊息不得包含 secrets。
- 已停止、缺失或斷線的 Codex session 不會被喚醒，也不會被別的對話頂替；失敗的 exact-session 原生傳遞不會自動重播，sender 必須明確重試。scope 相符的 recovery data 仍會保留，`memesh message storage report` 可以看目前存了什麼。原生傳遞目前只支援 macOS 和 Linux。
- 這條文件化的原生路徑涵蓋一般 Codex CLI。除非確切且正在執行的 session 出現在 `message discover`，否則不要假設 Codex Desktop 或未連接的 task 已註冊；這是證據邊界，不代表這些 host 一律不相容。

---

<p align="center"><strong>MIT 授權</strong></p>
