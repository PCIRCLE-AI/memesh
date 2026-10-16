🌐 [English](README.md) | [繁體中文](README.zh-TW.md)

# MeMesh

**讓 Claude Code 和 Codex 共用本機記憶。**

MeMesh 幫你的程式開發 AI 記住偏好、專案決策和過去的教訓，讓你不用每次開新對話，都重新解釋同樣的事。

- **換對話也記得。** 存下決策或教訓，下次需要時再找回來。
- **不同工具共用。** 同一台電腦上的 Claude Code 和 Codex 可以使用相同記憶。
- **留下交接。** 記下工作停在哪裡，供下一個對話確認。
- **互相傳訊息。** 正在執行的本機 agent 可以交換任務、問題和結果。

記憶存放在你電腦上的單一檔案：`~/.memesh/knowledge-graph.db`。MeMesh 不需要雲端記憶服務，也不另跑 AI 模型。自動提醒依工具整合而定；交接提供背景，不代表任務一定會自動接續。

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

若也需要命令列工具，先安裝 [Node.js 22.13+](https://nodejs.org)，再執行：

```bash
npm install -g @pcircle/memesh
memesh doctor
```

[安裝與更新指南](llms-install.md) · [其他工具整合](docs/platforms/README.md)

## 使用

直接用平常說話的方式請 agent 幫忙：

> 記住這個專案使用 SQLite。
>
> 上次登入功能是怎麼決定的？
>
> 記下目前進度，方便下一個對話接手。

Claude Code 插件提供自動記錄和提醒。Codex 插件在獲准執行 hooks 後，可以在對話開始時帶入記憶；其他自動記錄行為依工具而異。你也可以直接請 agent 儲存或查找記憶。

[完整工具與指令說明](docs/api/API_REFERENCE.md) · [Agent 訊息](docs/platforms/agent-messaging.md) · [運作方式](docs/ARCHITECTURE.md) · [參與開發](CONTRIBUTING.md)

<details>
<summary>工具與整合細節</summary>

## 全部 12 個記憶與協作工具

| 工具 | 用途 |
|------|------|
| `remember` | 儲存記憶；決策需要附上原因。 |
| `recall` | 查找記憶。 |
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

插件共有 10 個 hook 指令。「記住這件事」提醒支援 5 種語言；本版內含的
Dashboard 有 4 個分頁、11 種語言。

排序權重：相關性 30%、新近程度 25%、使用頻率 18%、信心 17%、回憶影響 10%。詳見[架構說明](docs/ARCHITECTURE.md)。

</details>

[MIT 授權](LICENSE)
