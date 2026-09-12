🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [Deutsch](README.de.md)

<p align="center">
  <h1 align="center">MeMesh</h1>
  <p align="center">
    <strong>Ein Gedächtnis für deinen KI-Coding-Assistenten, das von Sitzung zu Sitzung bleibt.</strong><br />
    Eine SQLite-Datei. Kein Docker, keine Cloud.
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@pcircle/memesh"><img src="https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=3b82f6&label=npm" alt="npm" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="MIT" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.13.0-22c55e?style=flat-square" alt="Node" /></a>
    <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-a855f7?style=flat-square" alt="MCP" /></a>
  </p>
</p>

---

## Was es tut

Mit jeder neuen Sitzung fängt dein KI-Coding-Assistent (Agent) bei null an. Er schlägt wieder den Ansatz vor, den du letzten Monat verworfen hast, scheitert wieder am selben Test und lässt sich die Architektur erklären, die er selbst mit entworfen hat.

MeMesh merkt sich das für ihn. Claude-Code-Hooks erfassen und laden den laufenden Arbeitskontext; unterstützte Clients teilen sich über ihre dokumentierte Integration dieselbe lokale SQLite-Datenbank. Funktioniert mit Claude Code, Codex, Cursor und anderen MCP-Clients.

```
   du arbeitest mit dem Agenten
            |
            v
   +------------------+      +------------------+
   |  festhalten      |      |  erinnern        |
   |  Sitzungen,      | ---> |  beim Start und  |
   |  Commits, Fixes  |      |  vor jeder       |
   |  (automatisch)   |      |  Änderung        |
   +------------------+      +------------------+
            |                         ^
            v                         |
   +----------------------------------------+
   |  ~/.memesh/knowledge-graph.db           |
   |  Entscheidungen, Lektionen, Verweise    |
   +----------------------------------------+
```

- **Erfassen, Erinnern, Hinweise und Schutz im richtigen Moment.** MeMesh liefert **9 Hook-Befehle** über seine Claude-Code- und Codex-Integrationen: Acht Claude-Code-Hooks laufen beim Sitzungsstart, vor Dateiänderungen, nach `git commit`, nach einem freigegebenen Plan oder einer beantworteten Frage, wenn Claude aufhört, vor dem Kürzen des Kontexts, bei „remember this“ (in 5 Sprachen, Deutsch nicht darunter) und vor einem riskanten Befehl, der eine bestätigte Lektion wiederholen würde. Die Plan-/Frage- und „remember this“-Hooks erinnern den Agenten nur an `remember`; der neunte Befehl verarbeitet sowohl Codex SessionStart als auch SessionEnd und registriert beziehungsweise beendet eine geeignete gewöhnliche Codex-CLI-Sitzung kontrolliert.
- **Ein Gedächtnis für alle Tools.** Was du heute in Claude Code speicherst, steht morgen auch Codex oder Cursor zur Verfügung.
- **Agenten können sich Nachrichten hinterlassen.** Der dauerhafte lokale Posteingang übersteht Neustarts; unter macOS oder Linux kann auch eine exakt adressierte, aktive gewöhnliche Codex-CLI-Sitzung mit MeMesh-Plugin die begrenzte Nachricht über ihre native Queue erhalten.
- **Ein Dashboard** zum Stöbern: 4 Tabs, 11 Sprachen, unter `http://localhost:3737/dashboard`.

---

## Läuft mit

| Plattform | Anbindung | Hinweis |
|---|---|---|
| Claude Code | Plugin: Hooks, MCP-Tools, `/memesh`-Skill | Automatisches Festhalten und Erinnern |
| Codex CLI | Plugin oder MCP-Server (`memesh-mcp`) | Plugin ohne manuelle Konfiguration oder `codex mcp add memesh -- memesh-mcp` |
| Gemini CLI | MCP-Server (`memesh-mcp`) | `gemini mcp add -s user memesh memesh-mcp` |
| Cursor, Cline und andere MCP-Clients | MCP-Server (`memesh-mcp`) | Client auf `memesh-mcp` zeigen lassen |
| Hermes Agent | Natives Memory-Provider-Plugin | [docs/platforms/hermes-agent.md](docs/platforms/hermes-agent.md) |
| OpenClaw | Natives Memory-Plugin | Nur Quellcode; weder veröffentlicht noch live getestet: [docs/platforms/openclaw.md](docs/platforms/openclaw.md) |
| Eigene Skripte und Apps | HTTP-API aus `memesh serve` | [docs/platforms/universal.md](docs/platforms/universal.md) |
| ChatGPT, Gemini im Browser und andere gehostete Chats | HTTP-API über eine lokale Brücke, die du selbst betreibst | [docs/platforms/README.md](docs/platforms/README.md) |

Die acht Claude-Code-Hooks übernehmen automatisches Erfassen, Erinnern, Hinweise und Schutz. Das Codex-Plugin richtet seine SessionStart-Integration und die MCP-Tools automatisch ein. Reine MCP-Clients rufen `recall` und `briefing` selbst auf.

Abruf und Erfassung bleiben lokal und deterministisch: SQLite-FTS5-Suche, explizite Memory-Tools und regelbasierte Hooks. Diese Version konfiguriert oder kontaktiert keinen LLM-, Embedding- oder Vektor-Provider. Veraltete Provider-Einstellungen früherer Versionen bleiben auf der Festplatte, werden aber ignoriert; `memesh doctor` nennt nur die Namen der obersten Felder, ohne ihre Werte zu lesen oder auszugeben.

---

## Installation

Plugin-Installationen und die npm-globale CLI nutzen dieselbe Datenbank. Claude-Code-Nutzer installieren meist Plugin und CLI; Codex kann sein eigenes Plugin oder den MCP-Server der CLI verwenden.

```
   Claude-Code-Chat                Terminal, Codex, Cursor
         |                                  |
         v                                  v
   +-----------------+              +------------------+
   | A: Plugin       |              | B: npm global    |
   | /plugin install |              | npm install -g   |
   | Hooks + Tools   |              | memesh-Befehl    |
   | + /memesh-Skill |              | + memesh-mcp     |
   +-----------------+              +------------------+
         |                                  |
         +---------------+------------------+
                         v
            ~/.memesh/knowledge-graph.db
               (eine Datei, beide Wege)
```

**A. Direkt in Claude Code** (Hooks, Tools und der `/memesh`-Skill werden automatisch eingerichtet):

```
/plugin marketplace add PCIRCLE-AI/memesh
/plugin install memesh@pcircle-memesh
```

Claude Code neu starten. Beim nächsten Start steht `◉ MeMesh` ganz oben.

**B. Im Terminal** (braucht [Node 22.13 oder neuer](https://nodejs.org)):

```bash
npm install -g @pcircle/memesh
memesh doctor          # prüft den lokalen Installationszustand und nennt Korrekturen
memesh install-hooks   # nur ohne A nötig: richtet Claude Code ein, deine eigenen Hooks bleiben
```

Codex ohne manuelle Konfiguration: `codex plugin marketplace add PCIRCLE-AI/memesh` und `codex plugin add memesh@pcircle-memesh`. Die manuelle Alternative ist `codex mcp add memesh -- memesh-mcp`. Für Cursor `{ "mcpServers": { "memesh": { "command": "memesh-mcp" } } }` in `~/.cursor/mcp.json` eintragen.

> **Das Plugin bringt keinen `memesh`-Befehl mit.** Nach `/plugin install` meldet das Terminal bei `memesh` noch `command not found`, bis du auch `npm install -g @pcircle/memesh` ausführst. Wer MeMesh nur im Claude-Code-Chat nutzt, kommt mit A aus.

**Aktualisieren:** Claude-Code-Plugin: `memesh upgrade-plugin` (ohne CLI: `npx @pcircle/memesh upgrade-plugin`). Codex-Plugin: `codex plugin marketplace upgrade pcircle-memesh && codex plugin add memesh@pcircle-memesh`. Globale npm-CLI: `memesh update`. **Soll eine KI die Installation übernehmen?** Gib ihr [llms-install.md](llms-install.md).

---

## Loslegen

```bash
memesh remember "Login verwendet OAuth 2.0 mit PKCE"
memesh recall "Login"
# -> findet die PKCE-Entscheidung

memesh briefing        # was der Agent über dieses Projekt weiß und wo du aufgehört hast
memesh serve           # startet den lokalen Server und gibt die Dashboard-URL aus
```

Lass `memesh serve` laufen und öffne die ausgegebene URL. Für die Memory-Tools brauchst du in Claude Code nicht einmal das Terminal: Sag im Chat „remember this“, und das Briefing kommt bei jedem Sitzungsstart von selbst.

Zwei Dinge, die du kennen solltest, sobald Erinnerungen da sind:

- `forget` archiviert eine Erinnerung, statt sie zu löschen. Eine neuere Erinnerung kann eine ältere ablösen.
- Ein laufender Agent kann mit `work_package` einen Kalender-Digest oder begrenzte sichtbare Züge aus dem neuesten geeigneten aktuellen Claude-Code-Transkript vorbereiten. Der Transkriptmodus erfordert genau einen passenden MCP-Datei-Root des Clients; fehlende oder mehrdeutige Roots und begrenzte Scanfehler scheitern geschlossen. Die Einreichung bewahrt redigierte Quellzüge auf und stellt nur einen Vorschlag zur menschlichen Prüfung bereit; Agenten können ihn nicht anwenden oder ablehnen, und MeMesh kontaktiert keinen Provider. Die exakten Suchgrenzen stehen in der [API-Referenz](docs/api/API_REFERENCE.md#work_package).

Alle Befehle und Tools: [docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md). Aufbau: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Mitmachen: [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Alle 12 Memory- und Koordinations-Tools

| Tool | Was es tut |
|------|-------------|
| `work_package` | Einen begrenzten, nicht vertrauenswürdigen Kalender-Digest oder ein Claude-Code-Transkript-Paket unter einem passenden MCP-Workspace-Root vorbereiten; genau ein striktes Ergebnis zur menschlichen Prüfung einreichen oder ohne dauerhafte Änderung zurückstellen. Die Transkript-Einreichung bewahrt begrenzte redigierte Quellzüge auf; Dateipfad, verborgenes Denken, Provider-, Embedding- oder Vektordaten werden nicht offengelegt. |
| `remember` | Wissen mit Beobachtungen, Relationen und Tags speichern — oder Freitext als `note` übergeben, woraus Titel, Beobachtungen und Name abgeleitet werden; `replace` korrigiert eine Erinnerung an Ort und Stelle |
| `recall` | Lokale FTS5-Suche mit Multi-Faktor-Bewertung (Relevanz, Aktualität, Häufigkeit, Konfidenz, Abruf-Auswirkung) |
| `forget` | Soft-Archivierung (löscht nie) oder entfernt spezifische Beobachtungen |
| `export` | Memories als JSON sichern, migrieren oder zwischen kompatiblen Agenten übertragen |
| `import` | Memories mit Merge-Strategien importieren (Skip / Overwrite / Append) |
| `learn` | Strukturierte Lektionen aus Fehlern erfassen (Fehler, Grundursache, Behebung, Prävention) |
| `task_state` | Arbeitsstand lesen oder festhalten — Ziel, nächster Schritt, Blocker, gerade Erledigtes |
| `briefing` | Die Arbeitstopologie für jeden MCP-Client, abgeschlossen durch einen begrenzten Index der dauerhaften Memories des Projekts; allgemeiner Kontext bleibt still, während exakte Angaben für `project` + `recipient` nur dessen noch nicht abgerufene Zustellungen anzeigen |
| `user_patterns` | Arbeitsmuster analysieren — Zeitplan, Tools, Stärken, Lernbereiche |
| `improvement` | Evidenzverknüpfte Produktverbesserung zur menschlichen Prüfung vorschlagen oder ihren Status lesen; Agenten können sie nicht selbst annehmen oder ablehnen |
| `message` | Aktive Agenten finden und nicht vertrauenswürdige Nachrichten mit exaktem Empfänger austauschen. Dauerhafter JSON-Payload: max. 64 KiB; vollständiger nativer Envelope: max. 16 KiB mit getrennten Fehlern `native_message_too_large` und `recipient_unavailable`. Native Annahme, Discovery, Poll und Fetch bedeuten weder Bestätigung noch Workflow-Status |

---

## Das Kleingedruckte

**Bewertete Reihenfolge** — Ergebnisse sortiert nach Relevanz (30%) + Aktualität (25%) + Häufigkeit (18%) + Konfidenz (17%) + Abruf-Wirkung (10%).

**Agenten-Nachrichten, die genauen Regeln** (ausführlich: [docs/platforms/agent-messaging.md](docs/platforms/agent-messaging.md)):

- Heute verfügbar: Ein Sender über MCP, HTTP oder CLI kann einen nicht vertrauenswürdigen, JSON-kodierten Payload von höchstens 65.536 UTF-8-Bytes (64 KiB) dauerhaft an genau einen lokalen Empfänger senden. Der Empfänger kann ihn getrennt abrufen, nach einem Neustart mit einem opaken Cursor fortsetzen und Intake, Bestätigung, Workflow-Status und Host-Aktivierung getrennt protokollieren.
- Mit aktiviertem MeMesh-Codex-Plugin registriert sich jeder gestartete oder fortgesetzte gewöhnliche Codex-CLI-Thread mit gültiger Thread-Identität und vorhandenem Arbeitsverzeichnis automatisch mit einer threadbezogenen Identität; ein manuelles `agent setup` ist nicht erforderlich. SessionStart startet einen benutzereigenen, abgekoppelten Companion, weil Codex beim Beenden des CLI-Prozesses ein asynchrones Hook-Kind beendet. SessionEnd lässt ein begrenztes 45-Sekunden-Fenster für die inaktive Queue offen; Resume ersetzt die vorherige exakte Generation, und nach Ablauf wird die Registrierung entfernt. Eine in diesem Fenster angenommene Nachricht wird beim Fortsetzen desselben Threads für das Modell sichtbar; dies ist keine Behauptung, dass eine gestoppte Oberfläche geweckt wurde. `memesh agent setup codex-session` bleibt optional, wenn ein Workspace einen stabil benannten Principal benötigt. Der vollständige native Envelope einschließlich Routing-Metadaten und Payload ist separat auf 16.384 Bytes (16 KiB) begrenzt. Ein Exact-Session-Send ist erst erfolgreich, wenn die native Queue ihn annimmt; ein zu großer Envelope meldet `native_message_too_large`, ein nicht erreichbarer lokaler Router meldet `router_unreachable`, andere nicht verfügbare oder abgelehnte Sessions melden `recipient_unavailable`. Eingegrenzte Recovery-Daten bleiben für alle Sender- und Empfängerfehler erhalten, und Principal-Ziele behalten Durable Store-and-Forward bei. Native Annahme bedeutet weder Bestätigung noch Workflow-Status; native Nachrichten dürfen keine Secrets enthalten.
- Eine gestoppte, fehlende oder getrennte Codex-Session wird weder geweckt noch ersetzt; eine fehlgeschlagene native Exact-Session-Zustellung wird nicht automatisch wiederholt, der Absender muss bewusst erneut senden. Eingegrenzte Recovery-Daten bleiben verfügbar; `memesh message storage report` zeigt, was gespeichert ist. Native Zustellung gibt es nur unter macOS und Linux.
- Dieser dokumentierte native Pfad gilt für die gewöhnliche Codex CLI. Nimm bei Codex Desktop oder einem nicht angehängten Task keine Registrierung an, solange die exakte laufende Session nicht in `message discover` erscheint; das ist eine Evidenzgrenze, keine pauschale Inkompatibilitätsaussage.

---

<p align="center"><strong>MIT-Lizenz</strong></p>
