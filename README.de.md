# Agent Workbench

[![npm](https://img.shields.io/npm/v/agent-workbench)](https://www.npmjs.com/package/agent-workbench)
[![CI](https://github.com/cvelasquez/agent-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/cvelasquez/agent-workbench/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/agent-workbench)](LICENSE)
[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge.svg)](https://github.com/hesreallyhim/awesome-claude-code)

[English](README.md) · [Español](README.es.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · [Français](README.fr.md) · **Deutsch**

**Eine visuelle Werkbank für die Coding-Agenten, die Sie bereits nutzen: die
CLIs von Claude Code, Codex, OpenCode, Antigravity und Pi.** Agent Workbench
läuft auf Ihrem Computer und öffnet sich in Ihrem Browser. Es verwendet die
CLIs, die bei Ihnen schon installiert und angemeldet sind, rührt Ihre
Zugangsdaten nie an und stellt von sich aus keine Netzwerkanfragen.

```bash
npx agent-workbench
```

![Ein Rundgang: die Unterhaltung als Karten, die geänderten Dateien und ein Diff, ein Tab pro CLI und das Fortsetzen einer Unterhaltung mit einer anderen CLI](assets/demo.webp)

## So funktioniert es

Agent Workbench spricht mit keinem KI-Dienst. Es startet die CLI, die Sie bereits
haben – `claude`, `codex`, `opencode`, `agy` oder `pi` –, in einem echten
Terminal und ergänzt drumherum, was ein Terminal allein nicht bietet: Tabs, Ihre
früheren Unterhaltungen, die Unterhaltung als gut lesbare Karten, eine
Kontextanzeige, die geänderten Dateien und einen Dateibaum.

Das Terminal bleibt das Terminal: Alles, was Sie tippen, geht direkt an die CLI.

---

## Was Sie bekommen

| | |
|---|---|
| **Tabs** | Mehrere Agenten gleichzeitig, aus jeder CLI, jeder in seinem eigenen Ordner. Ein Punkt auf jedem Tab zeigt, ob der Agent arbeitet, bereit ist oder auf Sie wartet. Das Neuladen der Seite stoppt nichts: Die CLIs laufen auf dem Server, nicht im Browser. |
| **Schneller Start** | Wenn Sie die App öffnen, kommen Ihre Tabs **schlafend** zurück: Sie können sie vollständig lesen, und keine CLI startet, bevor Sie auf **CLI öffnen** klicken. |
| **Historie** | Ihre Projekte und früheren Unterhaltungen in der Seitenleiste, aus allen CLIs, mit Filter. Ein Klick auf eine Unterhaltung setzt sie dort fort, wo Sie aufgehört haben, mit ihrer CLI. Archivieren Sie alte Sitzungen oder ein ganzes Projekt, um aufzuräumen: Es wird nichts gelöscht, und es lässt sich rückgängig machen. |
| **Unterhaltung** | Die Nachrichten als Karten, live, mit eingeklappten Tool-Aufrufen. Ältere Nachrichten werden beim Hochscrollen geladen. Sie können suchen, jede Nachricht und jeden Codeblock kopieren und zu Ihrer vorherigen Nachricht (↑) oder ans Ende (↓) springen. Eine Zeile unten zeigt, wann Ihre Nachricht bei der CLI angekommen ist und ob der Agent noch arbeitet. Je nach CLI können Sie die Fragen des Agenten direkt dort beantworten. Eine Datei des Projekts, die der Agent nennt, öffnet sich mit einem Klick im Tab „Dateien“. Mit Claude Code kommt eine Nachricht, die Sie anhalten, bevor der Agent beginnt, zum Korrigieren ins Eingabefeld zurück, und **↩** an einer Nachricht geht zurück vor sie: die Unterhaltung und, wenn Sie wollen, der Code. Eine Nachricht, die Sie senden, während der Agent arbeitet, wartet am Ende als eingereiht; je nach CLI lässt **Senden jetzt erzwingen** den Agenten sie sofort lesen, und **Bearbeiten** (oder ↑ im leeren Feld) holt sie zum Korrigieren ins Eingabefeld zurück. |
| **Eingabefeld** | Platz zum Schreiben, zum Einfügen von Bildern und zum Anhängen von Dateien; langer eingefügter Text wird zu einem übersichtlichen Chip. Was Sie gerade tippen, übersteht das Schließen der App und erscheint live in jedem offenen Fenster. Umschalt+Eingabe setzt eine nummerierte Liste oder eine Aufzählung fort. |
| **Kontextanzeige** | Wie viel vom Kontextfenster des Modells die Unterhaltung belegt. Tokens, nie Geld. Ab 70 % bittet **Kompaktieren** die CLI, die Unterhaltung zu kompaktieren. Daneben steht bei Claude Code, Codex und Antigravity CLI, wie viel Sie von den Nutzungslimits Ihres Plans verbraucht haben und wann sie zurückgesetzt werden. |
| **Änderungen** | Der Branch, die geänderten Dateien und ihr Diff. **Orchestriert Agenten parallel**: Öffnen Sie das Projekt in einem neuen Branch, in einem eigenen Ordner, und mehrere Agenten arbeiten gleichzeitig, ohne sich gegenseitig die Änderungen zu überschreiben. „Änderungen“ zeigt jeden Branch: was noch nicht committet ist, wie viele Commits er hat und ob er schon integriert ist. Eine andere CLI prüft einen Branch, ohne ihn zu ändern, und Sie integrieren ihn mit einem Klick in main. |
| **Dateien** | Der Dateibaum des Projekts, mit Suche und einer Vorschau mit Syntaxhervorhebung. Öffnen Sie mehrere Dateien gleichzeitig, jede in ihrem eigenen Tab; Markdown-Dateien öffnen sich formatiert. Ein Klick fügt den Pfad einer Datei in Ihre Nachricht ein. Bearbeiten Sie eine Textdatei, etwa eine `.env`, und speichern Sie sie direkt dort: Hat der Agent sie inzwischen geändert, wird nichts überschrieben, und Sie übernehmen Ihre Änderungen in die neue Version. |
| **Pläne** | Die Pläne und `.md`-Dokumente, die die Unterhaltung geschrieben hat, formatiert dargestellt. Ein Klick fügt den Pfad eines Dokuments in Ihre Nachricht ein. |
| **Notizen** | Ein Notizblock neben der Unterhaltung, Bilder inklusive. Mit Claude Code schickt ein Klick eine Notiz an eine neue Unterhaltung. |
| **Konsole** | Das Terminal Ihres Systems am unteren Rand, im Ordner des Projekts: PowerShell, cmd oder Git Bash unter Windows; bash oder zsh unter macOS und Linux. |
| **Fortsetzen mit…** | Mit mehr als einer CLI setzen Sie eine Unterhaltung mit einer anderen CLI im selben Ordner fort. Der neue Agent startet mit einem Transkript der letzten Runden. |
| **Benachrichtigungen** | Ein Ton und auf Wunsch Systembenachrichtigungen, wenn ein Agent fertig ist oder auf Sie wartet. |
| **Einstellungen** | ⚙ in der Kopfzeile: die Sprache, das Design des Terminals, welche Bereiche angezeigt werden, welche Konsole sich öffnet und welche CLIs die App verwendet. |
| **Neun Sprachen** | English, Español, 简体中文, 日本語, Português (Brasil), Русский, 한국어, Français und Deutsch. Die App folgt der Sprache Ihres Browsers. |
| **Design** | Hell, dunkel oder wie das System. Das Terminal bleibt standardmäßig dunkel, damit die Farben der CLIs lesbar bleiben. |

Optional und standardmäßig ausgeschaltet: ein
[gemeinsames Gedächtnis](#gemeinsames-gedächtnis-für-alle-clis) für alle CLIs,
eine [Sicherung](#sicherung-ihrer-historie) Ihrer Historie, bei Claude Code die
[Nutzungslimits Ihres Plans](#claude-code-nutzungslimits-ihres-plans),
[Fernzugriff](#fernzugriff-über-ssh) von einem anderen Computer oder einem
Telefon aus und eine [Android-App](#die-android-app).

<p>
  <img src="assets/captura-cambios.png" width="49%" alt="Das Panel „Änderungen“: Branch und geänderte Dateien, nach Gruppen">
  <img src="assets/captura-diff.png" width="49%" alt="Der Diff einer dieser Dateien, im selben Panel">
</p>

### Mit mehr als einer CLI

Jede Sitzung und jeder Tab zeigt ein kleines Badge mit der jeweiligen CLI, und
über das `+` für einen neuen Tab wählen Sie, welche geöffnet wird. Mit nur einer
CLI sehen Sie davon nichts.

<img src="assets/captura-clis.png" width="45%" alt="Die Projektliste mit Sitzungen aus mehreren CLIs, jede mit ihrem Badge, und das Menü + mit den fünf CLIs und ihren Versionen">

**Nicht jede CLI gibt dieselben Informationen preis**, daher hängen einige
Funktionen von der CLI ab:

| | Claude Code | Codex | OpenCode | Antigravity CLI | Pi |
|---|:---:|:---:|:---:|:---:|:---:|
| Punkt auf dem Tab: arbeitet, bereit, wartet auf Sie | ✓ | — | ✓ ¹ | ✓ ² | ✓ |
| Fragen des Agenten in der Unterhaltung beantworten | ✓ | — | ✓ ¹ | — | — |
| Kontextanzeige | ✓ | ✓ | ✓ | ✓ ² | ✓ |
| Auswahl von Modus und Modell | ✓ | — | — | ✓ | ✓ ³ |
| Bilder einfügen | ✓ | ✓ | ✓ | — | ✓ ³ |
| Tab „Pläne“ | ✓ | — | — | — | — |
| Notiz an eine neue Unterhaltung senden | ✓ | — | — | — | — |

Für alles andere ist immer das eigene Terminal der CLI da: Wo ein „—“ steht,
beantworten Sie zum Beispiel Fragen dort.

¹ Bei OpenCode startet die App dafür einen lokalen OpenCode-Server
([Details](#ihre-daten-und-sicherheit)).
² Nur, wenn Sie die Statuszeile von Antigravity CLI einrichten
([Anleitung](#antigravity-cli-status-und-kontextanzeige)).
³ Pi hat keine Berechtigungsmodi: Auswählen lassen sich das Modell und die
Denkstufe. Außerdem hängt Pi nicht an, was Sie einfügen: Ein Bild wird als
Dateipfad übergeben, den das Modell selbst öffnet.

---

## Voraussetzungen

- **Node.js 20 oder neuer.** Für die Historie von OpenCode und die Titel der
  Unterhaltungen von Antigravity CLI **22.13 oder neuer**: Beides wird mit dem
  SQLite gelesen, das seit dieser Version in Node eingebaut ist. Mit einer
  älteren Version funktioniert alles andere.
- **git**, für das Panel „Änderungen“. Alles andere funktioniert auch ohne.
- **Mindestens eine CLI**, installiert und angemeldet:

| CLI | Befehl | Installation |
|---|---|---|
| Claude Code | `claude` | [Installationsanleitung](https://docs.claude.com/en/docs/claude-code/setup) |
| Codex | `codex` | [Anleitung](https://learn.chatgpt.com/docs/codex/cli) |
| OpenCode | `opencode` | [Dokumentation](https://opencode.ai/docs/) |
| Antigravity CLI | `agy` | [Anleitung](https://antigravity.google/docs/cli/getting-started) |
| Pi | `pi` | [pi.dev](https://pi.dev) |

Agent Workbench enthält keine CLI und lädt auch keine herunter: Es findet die,
die in Ihrem `PATH` liegen. Gibt es keine, sagt es Ihnen das und öffnet keine
Sitzungen.

**Plattformen.** Entwickelt und täglich genutzt unter Windows 11 mit PowerShell.
Unter macOS und Linux wird jede Änderung automatisch installiert und gestartet,
im Alltag werden sie aber weniger genutzt: Rückmeldungen sind willkommen. Unter
Linux wird bei der Installation das Terminalmodul kompiliert, daher brauchen Sie
`python3`, `make` und einen C++-Compiler (`build-essential` unter Debian und
Ubuntu).

---

## Installieren und starten

```bash
npm install -g agent-workbench
```

Dann, im Ordner des Projekts, an dem Sie arbeiten möchten:

```bash
agent-workbench
```

Ihr Browser öffnet sich mit einer Adresse wie dieser:

```
  URL          http://127.0.0.1:52341/?token=…
```

Diese Adresse ist der einzige Zugang: Das Token ändert sich bei jedem Start, und
die App lauscht nur auf Ihrem eigenen Computer (`127.0.0.1`).

Zum einmaligen Ausprobieren ohne Installation: `npx agent-workbench`. Beim ersten
Mal werden etwa 60 MB heruntergeladen, vor allem das native Modul des Terminals.
Für den täglichen Gebrauch ist die globale Installation besser.

---

## Tastenkürzel

| Tasten | Aktion |
|---|---|
| `Alt+T` | Neuer Tab |
| `Alt+W` | Tab schließen |
| `Alt+←` / `Alt+→` (oder `Alt+PgUp` / `Alt+PgDn`) | Vorheriger / nächster Tab |
| `Alt+P` | Rechtes Panel ein- oder ausblenden |
| `Shift+Tab`, außerhalb des Terminals | Zurück zum vorherigen Tab |

Die Schaltfläche `?` in der Kopfzeile listet alle auf, zusammen mit den eigenen
Tastenkürzeln der aktiven CLI. Die Kürzel verwenden `Alt`, weil der Browser
`Ctrl+T`, `Ctrl+W` und `Ctrl+Tab` für seine eigenen Tabs behält und nie an die
Seite weitergibt.

Alle anderen Tasten – `Esc`, `Ctrl+C`, `Ctrl+R`, `Ctrl+O`, die Pfeiltasten,
`Alt+V` zum Einfügen von Bildern – kommen unverändert bei der CLI an. Auch
`Ctrl+V`: Was die Tastenkombination dort tut, entscheidet die CLI. Nur in der
Konsole unten fügt `Ctrl+V` unter Windows Text ein, wie im Windows Terminal.

---

## Optionale Extras

### Gemeinsames Gedächtnis für alle CLIs

Jede CLI legt das, was sie über ein Projekt lernt, an ihrem eigenen Ort ab, und
die anderen sehen es nicht. Der Tab **Gedächtnis** richtet ein Gedächtnis für
sie alle ein: Notizen im Ordner `.agents/memory/` des Projekts, die jede CLI –
von hier oder aus ihrem eigenen Terminal – über `AGENTS.md` und `CLAUDE.md`
liest und schreibt. Der Tab ist anfangs ausgeblendet: Blenden Sie ihn über
⚙ Einstellungen ein.

**Vorschau der Änderungen** zeigt Datei für Datei, was geschrieben würde, und
nichts wird angerührt, bevor Sie bestätigen. Beim Einrichten wird das Gedächtnis
importiert, das Claude Code für dieses Projekt bereits hatte. Die globalen
Einstellungen der einzelnen CLIs ändert die App nicht: Sie gibt Ihnen das
Snippet, das Sie selbst einfügen.

<img src="assets/captura-memoria.png" width="70%" alt="Der Tab „Gedächtnis“ mit der für die fünf CLIs installierten Brücke und den importierten Notizen">

### Sicherung Ihrer Historie

Die Historie gehört der jeweiligen CLI, und die CLI kann ihr Format ändern, sie
kürzen oder deinstalliert werden. Die Sicherung bewahrt eine Kopie Ihrer
Unterhaltungen – Nachrichten, Tool-Aufrufe und -Ergebnisse, Bilder und das
Gedächtnis jedes Projekts – in einem Ordner Ihrer Wahl auf, in Dateien, die Sie
auch ohne die App lesen können.

**Standardmäßig ist sie ausgeschaltet.** Sie öffnen sie über die Schaltfläche der
Sicherung oben in der Projektliste oder über ⚙ Einstellungen. **Messen** zeigt,
wie viel Platz sie pro CLI belegen würde, ohne etwas zu schreiben, und
**Einschalten** startet sie. Ab dann kopiert sie alles in der Seitenleiste, was
nicht archiviert ist, und kopiert eine Unterhaltung erneut, eine Minute nachdem
sie sich nicht mehr ändert. Aus diesem Ordner löscht sie nie etwas.

Bei eingeschalteter Sicherung:

- Unterhaltungen, die eine CLI nicht mehr hat, bleiben in der Seitenleiste, als
  „Sicherung“ markiert, und öffnen sich als Markdown.
- Jedes Projekt lässt sich als Markdown exportieren.
- Mit mehr als einer CLI kann der Filter der Seitenleiste **In Unterhaltungen**
  suchen: im Text von allem, was kopiert wurde, aus allen CLIs.

<img src="assets/captura-buscador.png" width="40%" alt="Suche in Unterhaltungen: ein Treffer in je einer Sitzung jeder CLI, mit seinem Ausschnitt">

Standardmäßig liegt sie im Konfigurationsordner der App
(`%APPDATA%\agent-workbench\vault` unter Windows). **Ordner ändern…** kopiert sie
in einen anderen – einen synchronisierten Ordner, ein anderes Laufwerk –, ohne
etwas zu überschreiben, und lässt den alten unverändert. Wenn Sie sie in einen
synchronisierten Ordner oder ein Repository legen, wandern Ihre Unterhaltungen
mit.

<details>
<summary>Historie aus Gemini CLI und der Antigravity IDE importieren</summary>

Zwei Importer für den einmaligen Gebrauch holen Historie aus Werkzeugen, die die
App nicht liest. Beide laufen aus dem Quellcode
([siehe unten](#aus-dem-quellcode)) und **schreiben nichts ohne `--write`**:
Ohne diese Option sagen sie nur, was sie importieren würden.

- `pnpm vault:import gemini-cli [--cwd <folder>]` – die Chats, die von
  Gemini CLI übrig geblieben sind. `--cwd` ist der Ordner, in dem Sie Gemini CLI
  verwendet haben, damit sie unter diesem Projekt abgelegt werden.
- `pnpm vault:import antigravity-ide --workspace <folder>` – was sich aus den
  Unterhaltungen der Antigravity IDE in diesem Ordner lesen lässt: die
  Zusammenfassung jeder Unterhaltung und ihre `.md`-Dokumente. Die Unterhaltung
  selbst ist verschlüsselt, daher wird sie als „teilweise“ markiert.

</details>

### Claude Code: Nutzungslimits Ihres Plans

Claude Code teilt nur über seine *Statuszeile* mit, wie viel Sie von den
Nutzungslimits Ihres Plans verbraucht haben (das 5-Stunden-Fenster und die
Woche). So sehen Sie sie neben der Kontextanzeige:

1. Öffnen Sie einen Claude-Code-Tab und klicken Sie auf **Konfigurieren**,
   neben der Kontextanzeige.
2. Kopieren Sie die angezeigte Zeile und fügen Sie sie zu dem hinzu, was
   `~/.claude/settings.json` bereits enthält. Die App ändert diese Datei nicht:
   Sie bearbeiten sie selbst.
3. Nach ein paar Sekunden oder mit **Prüfen** zeigt der Dialog **Konfiguriert**
   an. Die Limits erscheinen mit der nächsten Antwort.

Claude Code erlaubt nur eine Statuszeile, daher ersetzt diese jede andere, die
Sie haben, und mit ihr zeigt die CLI einige Hinweise an ihrem unteren Rand nicht
mehr an, etwa „esc to interrupt“. Die Zeile führt ein kleines Skript aus, das im
eigenen Ordner der App liegt: Es speichert nur die beiden Limits und die ID der
Sitzung und gibt sie als kurze Zeile am unteren Rand der CLI aus. Es läuft bei
**jeder** `claude`-Sitzung, auch bei denen, die Sie außerhalb der App öffnen,
und es braucht `node` im `PATH`. Claude Code veröffentlicht diese Limits nur bei
einem Abonnement-Plan, nicht mit einem API-Schlüssel.

Codex braucht nichts: Es schreibt die Limits in seine eigene Historie.
Antigravity CLI teilt sie über ihre Statuszeile mit, wie unten beschrieben.
OpenCode und Pi veröffentlichen sie nicht.

### Antigravity CLI: Status und Kontextanzeige

Antigravity CLI teilt nur über ihre *Statuszeile* mit, ob sie arbeitet oder auf
Sie wartet, wie viele Tokens sie verbraucht hat und wie viel von Ihrem
Kontingent übrig ist. Ohne Statuszeile funktionieren ihre Tabs normal, aber der
Punkt auf dem Tab meldet einen unbekannten Status, und die Anzeigen bleiben
leer. So schalten Sie sie ein:

1. Öffnen Sie einen Antigravity-Tab und klicken Sie auf **Konfigurieren**, neben
   der Kontextanzeige.
2. Kopieren Sie die angezeigte Zeile und fügen Sie sie zu dem hinzu, was
   `~/.gemini/antigravity-cli/settings.json` bereits enthält. Die App ändert
   diese Datei nicht: Sie bearbeiten sie selbst.
3. Nach ein paar Sekunden oder mit **Prüfen** zeigt der Dialog **Konfiguriert**
   an.

Die Zeile führt ein kleines Skript aus, das im eigenen Ordner der App liegt. Es
speichert nur Status, Modus, Modell und Tokens jeder Unterhaltung und von Ihrem
Kontingent nur, wie viel übrig ist und wann es zurückgesetzt wird. Ihre
E-Mail-Adresse, Ihren Plan und die Kosten, die die CLI ihm ebenfalls übergibt,
speichert es nicht. Es gibt nichts aus, sodass die eigene Statuszeile der CLI
bleibt, wie sie war. Einmal eingetragen, läuft es bei **jeder** `agy`-Sitzung,
auch bei denen, die Sie außerhalb der App öffnen, und es braucht `node` im
`PATH`.

### Fernzugriff über SSH

Lassen Sie Agent Workbench auf einem Computer laufen und nutzen Sie es von einem
anderen Computer in Ihrem Netzwerk aus, in dessen Browser, ohne dass dort eine
CLI installiert sein muss. **Die App wird nie zum Netzwerk hin geöffnet**: Sie
lauscht weiterhin nur auf `127.0.0.1`, und der andere Computer erreicht sie über
einen SSH-Tunnel. Der Tunnel ist auch das, was es zum Laufen bringt: Durch ihn
sieht der andere Browser die App als `localhost`, und das verlangen Browser für
die Zwischenablage und für Benachrichtigungen. **Standardmäßig ist der
Fernzugriff ausgeschaltet.**

**1. Auf dem Computer, auf dem die App läuft, einmalig: den SSH-Server
einschalten.** Das ist eine Systemänderung, die Administratorrechte braucht,
deshalb macht die App das nicht für Sie.

- **Windows 10/11** – in PowerShell *als Administrator*. Die erste Zeile lädt den
  Server herunter, installiert ihn und braucht einige Minuten: Warten Sie, bis
  die Eingabeaufforderung zurückkommt.

  ```powershell
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
  Start-Service sshd
  Set-Service -Name sshd -StartupType Automatic
  ```

- **macOS** – Systemeinstellungen → Allgemein → Teilen → **Entfernte Anmeldung**.
- **Linux** – installieren Sie den OpenSSH-Server Ihrer Distribution und schalten
  Sie ihn ein. Unter Debian oder Ubuntu:

  ```bash
  sudo apt install openssh-server
  sudo systemctl enable --now ssh
  ```

**2. In der App: ⇄ in der Kopfzeile → Fernzugriff einschalten, dann Agent
Workbench neu starten.** Der Tunnel braucht einen Port, der sich nicht ändert,
daher verwendet die App einen festen (standardmäßig 24837; Sie können ihn
ändern), und der Port wird beim Start festgelegt. Der Neustart schließt die
offenen CLIs; Ihre Tabs kommen schlafend zurück. Das *Ausschalten* wirkt dagegen
sofort.

**3. Auf dem anderen Computer, jedes Mal: den Tunnel öffnen.** Der Dialog zeigt
den Befehl, fertig zum Kopieren:

```
ssh -N -L 24837:127.0.0.1:24837 you@your-computer
```

Lassen Sie ihn laufen, und **verwenden Sie auf beiden Seiten denselben Port**:
Mit einem anderen lokalen Port antwortet die App mit 403. Mit
`-o ServerAliveInterval=30 -o ExitOnForwardFailure=yes` bemerkt der Tunnel ein
abgerissenes WLAN, statt hängen zu bleiben. Unter Windows können Sie den Befehl
in einer `.cmd`-Datei speichern und diese per Doppelklick starten.

**4. Diesen Computer koppeln, einmalig.** Im Dialog liefert **Gerät koppeln**
eine Adresse mit einem Einmalcode, etwa `http://localhost:24837/?pair=K7QM-X2RD`.
Öffnen Sie sie innerhalb von fünf Minuten im Browser des anderen Computers.
Danach öffnet dieser Browser einfach `http://localhost:24837`, auch nach einem
Neustart der App. Der Dialog listet die gekoppelten Geräte auf, und
**Widerrufen** sperrt eines sofort aus.

Ein gekoppeltes Gerät kann die ganze App nutzen, außer den Fernzugriff zu
verwalten und die wenigen Dinge, die ein Fenster auf dem Computer mit der App
öffnen würden, etwa *Mit der Standard-App öffnen*. Ein **Remote**-Badge in der
Kopfzeile zeigt das an. Bedenken Sie, dass die App eine Konsole enthält und
Agenten startet: Ein gekoppeltes Gerät kann also Befehle auf Ihrem Computer
ausführen, genau wie Sie. **Koppeln Sie nur Geräte, die Ihnen gehören.**

**Auf einem Telefon oder Tablet.** Über denselben Tunnel bekommt der Browser
eines Telefons ein einspaltiges Layout: Die Projektliste gleitet von der Seite
herein, die Tabs sitzen in der Kopfzeile, und eine Leiste wechselt zwischen der
Unterhaltung, der CLI, den Änderungen, den Dateien und dem Rest. Dieses Layout
erscheint in jedem Fenster, das schmaler als 768 px ist. Auf einem Touchscreen
beginnt Enter im Eingabefeld eine neue Zeile (gesendet wird über die
Schaltfläche „Senden“), und wenn Sie mit dem Finger über ein Terminal wischen,
scrollt es.

<details>
<summary>Ein sichererer SSH-Schlüssel, der nur für den Tunnel taugt (empfohlen)</summary>

Die SSH-Anmeldung ist die Ihres Benutzers auf diesem Computer: Ein Passwort oder
Schlüssel, der den Tunnel öffnet, öffnet dort also auch ein vollständiges
Terminal. Sie können einen Schlüssel erstellen, der nur für den Tunnel taugt:
Erzeugen Sie ihn auf dem anderen Computer (`ssh-keygen -t ed25519`) und tragen
Sie seine öffentliche Hälfte in `authorized_keys` auf dem Computer ein, auf dem
die App läuft, mit diesen Optionen davor:

```
restrict,port-forwarding,permitopen="127.0.0.1:24837",command="exit" ssh-ed25519 AAAA… other-computer
```

`restrict` allein lässt den Schlüssel noch Befehle ausführen; erst
`command="exit"` schließt diese Tür, und der Tunnel verlangt nie einen Befehl.
Unter Windows ist diese Datei, wenn Ihr Benutzer Administrator ist,
`C:\ProgramData\ssh\administrators_authorized_keys`, und nur Administratoren und
SYSTEM dürfen in sie schreiben; andernfalls ist es
`%USERPROFILE%\.ssh\authorized_keys`. Zum Prüfen versuchen Sie
`ssh you@your-computer whoami` mit diesem Schlüssel: Der Befehl sollte nichts
ausgeben und sofort enden, während der Tunnel mit `-N -L` weiter funktioniert.

</details>

### Die Android-App

Eine App für Android 10 und neuer öffnet den Tunnel für Sie und zeigt dieselbe
Oberfläche, von Ihrem Computer ausgeliefert, im Telefon-Layout. Sie bleibt im
Hintergrund verbunden und benachrichtigt Sie, wenn ein Agent fertig ist oder auf
Sie wartet, auch bei ausgeschaltetem Bildschirm; ein Tippen auf eine
Benachrichtigung öffnet den betreffenden Tab. Wenn das WLAN zurückkommt,
verbindet sie sich von selbst wieder.

Die App braucht den eingeschalteten Fernzugriff und den laufenden SSH-Server des
Computers (Schritte 1 und 2 oben). Es gibt sie bei
[Google Play](https://play.google.com/store/apps/details?id=io.github.cvelasquez.agentworkbench),
oder Sie bauen sie selbst aus [`android/`](android/), wie
[`CONTRIBUTING.md`](CONTRIBUTING.md#the-android-app) erklärt.

**Koppeln, einmalig:**

1. Wählen Sie im Dialog ⇄ **Telefon koppeln**. Er zeigt eine Zeile, die Sie in
   ein Terminal auf diesem Computer einfügen, und einen QR-Code. Unter Windows
   gehört die Zeile, wenn Ihr Benutzer Administrator ist, in PowerShell
   *als Administrator*; der Dialog sagt es Ihnen.
2. Fügen Sie die Zeile ein. Die Zeile gibt den Schlüssel des Telefons nur für
   den Tunnel frei: Damit erreicht das Telefon die App und sonst nichts – kein
   Terminal, keine Befehle.
3. Scannen Sie den QR-Code mit der App. Der Code funktioniert einmal und fünf
   Minuten lang, und der Dialog muss offen bleiben, bis sich das Telefon
   verbindet.

Der QR-Code enthält den privaten SSH-Schlüssel des Telefons. Ihr Computer hält
ihn nur im Arbeitsspeicher, bis das Telefon ihn verwendet, und schreibt ihn nie
auf den Datenträger: **Teilen Sie kein Foto dieses QR-Codes**. Das Telefon merkt
sich beim ersten Verbinden den SSH-Fingerabdruck Ihres Computers, und falls er
sich je ändert, verweigert es die Verbindung und sagt es Ihnen.

**Um ein Telefon zu entfernen**, klicken Sie im Dialog bei ihm auf
**Widerrufen** und löschen Sie seine Zeile aus `authorized_keys` (sie endet auf
`agent-workbench-phone`). Auf dem Telefon löscht
**Einstellungen → Diesen Computer vergessen** seinen Schlüssel und seine
Anmeldedaten.

Wenn Benachrichtigungen verspätet ankommen, während das Telefon ruht, lassen Sie
die App ohne Akkubeschränkungen laufen:
**Einstellungen → Akkueinstellungen der App öffnen**. Was die App auf dem Telefon
speichert und welche Berechtigungen sie anfordert, steht in
[`PRIVACY.md`](PRIVACY.md).

---

## Ihre Daten und Sicherheit

- **Agent Workbench sendet nichts, nirgendwohin.** Keine Telemetrie, keine
  Nutzungsanalyse, keine eigenen Netzwerkanfragen. Die Android-App spricht nur
  mit Ihrem Computer.
- **Jede CLI tut von sich aus weiterhin, was sie auch täte, wenn Sie sie von
  Hand öffnen würden:** Sie spricht mit ihrem KI-Anbieter, und sie sucht
  möglicherweise nach Updates oder sendet ihre eigenen Nutzungsdaten. Agent
  Workbench fügt dem nichts hinzu und schaltet es auch nicht ab: Es ändert die
  Einstellungen keiner CLI. Was jede CLI sendet, steht in ihrer eigenen
  Dokumentation.
- **Die App rührt Ihre Zugangsdaten nie an.** Es gibt keinen Anmeldebildschirm:
  Wenn eine CLI Sie zur Anmeldung auffordert, melden Sie sich in ihrem eigenen
  Terminal an, und die App bekommt davon nicht einmal etwas mit.
- **Die App liest die Historie der CLIs und schreibt nichts in deren Ordner.**
  Die Tabelle unten zeigt, was sie liest und was sie nie öffnet.
- **Die App schreibt nur in ihre eigenen Ordner**, dazu drei Dinge in Ihre
  Projekte: das gemeinsame Gedächtnis, nur wenn Sie es bestätigen; eine Datei,
  die Sie selbst im Tab „Dateien“ bearbeiten und speichern; und die eigenen
  Branches, die Sie öffnen, jeder in seinem Ordner neben dem Projekt, mit den
  Notizen, die beim Entfernen oder Integrieren in den Hauptordner zurückgehen.
- **Der Server lauscht nur auf Ihrem Computer** (`127.0.0.1`), auf einem
  zufälligen Port, mit einem neuen zufälligen Token bei jedem Start, und er
  weist Anfragen ab, die von anderen Webseiten kommen. Der Fernzugriff ändert
  daran nichts: Der Port wird zu einem festen, weiterhin auf `127.0.0.1`, und
  SSH – das Sie einschalten und kontrollieren – erledigt den Rest.
- **Git: Die App committet nie, pusht nie und schreibt keine Historie um.** Sie
  führt vier git-Befehle aus, die schreiben, jeden erst nach einer Bestätigung,
  die ihn zeigt: `git worktree add`, um einen Branch in einem eigenen Ordner zu
  öffnen, `git worktree remove` (nie mit `--force`), `git branch -d` (nur für
  einen Branch, den die App erstellt hat und der schon integriert ist) und
  `git merge --ff-only`, um einen Branch ohne neuen Commit in main zu
  integrieren. Die Commits machen die Agenten, in ihrem Terminal.

| CLI | Was die App liest | Was sie nie öffnet |
|---|---|---|
| Claude Code | Aus `~/.claude/`: `projects/` (die Historie und das Gedächtnis jedes Projekts, um es zu importieren), `sessions/` (ob die CLI auf Sie wartet) und `plans/`; aus `settings.json` nur das Modell und die Statuszeile. Für den Tab „Pläne“ außerdem die `.md`-Dateien, die die Unterhaltung im Projekt oder im temporären Ordner dieser Sitzung geschrieben hat – **nur die, die in der Unterhaltung genannt werden, die Sie gerade ansehen**, ohne einen Ordner zu durchsuchen | `.credentials.json` oder irgendein Token |
| Codex | Aus `~/.codex/` (oder `CODEX_HOME`): `sessions/` und `archived_sessions/` | `auth.json`, `config.toml` oder die `*.sqlite`-Datenbanken |
| OpenCode | Die Datenbank `opencode.db`, im Nur-Lese-Modus geöffnet, und daraus nur die Sitzungen, Nachrichten und Teile; dazu der Modellkatalog, für die Größe des Kontextfensters | `auth.json`, `opencode.json` oder die Tabellen für Konten, Zugangsdaten, Berechtigungen und geteilte Sitzungen |
| Antigravity CLI | Aus `~/.gemini/antigravity-cli/`: die Transkripte jeder Unterhaltung, `history.jsonl`, die letzte Unterhaltung jedes Ordners, Modell und Statuszeile aus `settings.json` und eine temporäre **Kopie** ihres Unterhaltungsindex; aus `~/.gemini/config/projects/` der Ordner jedes Projekts | Die MCP-Konfiguration der CLI, ihr Eintrag im Schlüsselbund des Systems, der Inhalt von `conversations/` und `~/.gemini/antigravity/`, der Ordner ihrer IDE |
| Pi | Aus `~/.pi/agent/` (oder `PI_CODING_AGENT_DIR`): die Sitzungen in `sessions/`, dazu `models-store.json`, der Modellkatalog, für die Größe des Kontextfensters und die Modellauswahl. Aus dem installierten Pi-Paket: dessen `package.json`, um die Version zu erfahren, ohne Pi auszuführen, und die eingebaute Modellliste | `auth.json`, `models.json`, `settings.json` oder die MCP-Konfiguration |

Die [Importer der Sicherung](#sicherung-ihrer-historie) lesen außerdem, wenn Sie
sie ausführen, was in ihrem Abschnitt steht. Die vollständige Liste, Datei für
Datei, steht in [`ARCHITECTURE.md`](ARCHITECTURE.md#4-what-is-read-from-each-cli).

<details>
<summary>Das Kleingedruckte: Spuren, Umgebungsvariablen und was die App schreibt</summary>

**Drei Spuren, die Sie kennen sollten:**

- **Das Lesen der OpenCode-Datenbank** bewirkt, was SQLite bei jedem Leser
  bewirkt: Es legt die Dateien `-wal` und `-shm` an, falls sie fehlen, und
  aktualisiert das Datum von `-shm`. Die App führt nie einen OpenCode-Befehl aus,
  um die Datenbank zu lesen.
- **Wenn das eigene Log eines Antigravity-Tabs nicht auftaucht**, liest die App
  die Dateien `log/cli-*.log` der CLI, die Ihre Nachrichten und die
  E-Mail-Adresse des Kontos enthalten – nur um die ID der Unterhaltung zu finden,
  und ohne eine Zeile davon zu behalten.
- **Mit OpenCode startet die App einen lokalen OpenCode-Server**
  (`opencode serve`): nur einen, vom Öffnen des ersten OpenCode-Tabs bis fünf
  Minuten nach dem Schließen des letzten oder bis Sie die App schließen. Er
  lauscht auf `127.0.0.1`, auf einem zufälligen Port, mit einem anderen Passwort
  bei jedem Start, auch wenn Ihre OpenCode-Konfiguration etwas anderes vorgibt.
  Die App fragt ihn nur nach dem Status der Sitzungen und nach offenen
  Berechtigungen und Fragen und lässt ihn eine Sitzung anlegen, eine Frage
  beantworten und eine Sitzung stoppen: nichts über Ihre Konfiguration oder Ihre
  Konten.

**Umgebungsvariablen.** Die CLIs erben Ihre Umgebung unverändert, ohne
zusätzliche Anmeldevariablen. Zwei Ausnahmen: Die App **entfernt**
`CLAUDE_CODE_CHILD_SESSION` – die Variable schaltet das Speichern der Historie
ab – und weist Sie mit einem Hinweis darauf hin, wenn sie das tut; und sie
**fügt** dem OpenCode-Server eine Variable **hinzu**, `OPENCODE_SERVER_PASSWORD`,
mit jenem Passwort, das bei jedem Start neu ist. Es ist kein Passwort eines
Kontos und gelangt in die Umgebung keines Tabs: Jeder OpenCode-Tab erhält es in
seiner Befehlszeile (`attach --password`), wo andere Programme, die unter Ihrem
Benutzer laufen, es sehen können. Es gilt nur für diesen Server und wird
ungültig, wenn Sie die App schließen.

**Was Pi von sich aus sendet.** Beim Start fragt Pi bei pi.dev die neueste
Version und den Modellkatalog ab und meldet dort jede Installation und jedes
Update. Diese Meldung schalten Sie in Pi ab, nicht hier: mit
`enableInstallTelemetry: false` in den Einstellungen von Pi oder mit der
Umgebungsvariable `PI_TELEMETRY=0`.

**Was die App schreibt:**

- **In ihren eigenen Konfigurationsordner:** die offenen Tabs, den Index-Cache,
  die Notizen, die archivierten Sitzungen, ungesendete Nachrichten, die
  Statuszeilen-Skripte für Claude Code und Antigravity mit dem, was sie
  speichern, die eigenen Branches, die die App erstellt hat, mit einer Kopie
  jeder Textnotiz, die sie hineinkopiert hat (um die Notizen später
  zusammenzuführen), und, wenn Sie sie einschalten, die
  Sicherung (oder in den Ordner, den Sie wählen). Bei eingeschaltetem
  Fernzugriff außerdem die Liste der gekoppelten Geräte: einen Namen, zwei
  Datumsangaben und einen Hash der Anmeldedaten jedes Geräts – nie die
  Anmeldedaten selbst.
- **In den temporären Ordner:** die Bilder und Dateien, die Sie einfügen oder
  anhängen; das Log jedes Antigravity-Tabs, das Ihre Nachrichten enthält, nur
  für Sie lesbar ist und beim ersten Start gelöscht wird, nachdem es 24 Stunden
  alt geworden ist; und das Transkript einer Unterhaltung, die Sie mit einer
  anderen CLI fortsetzen, das gelöscht wird, wenn Sie diesen Tab schließen, oder
  nach 24 Stunden. Um zu prüfen, ob ein eigener Branch Konflikte hätte, schreibt
  git seine Objekte in einen temporären Ordner statt in Ihr Repository, und der
  Ordner wird gleich danach gelöscht.
- **In Ihre Projekte drei Dinge:** das gemeinsame Gedächtnis, nur wenn Sie
  bestätigen, beschränkt auf `.agents/memory/`, auf das, was in `AGENTS.md` und
  `CLAUDE.md` zwischen seinen Markierungen steht, und auf ein paar Zeilen am Ende
  von `.gitignore`; eine Datei, die Sie im Tab „Dateien“ bearbeiten, wenn Sie
  sie speichern, wobei nur der Inhalt einer vorhandenen Datei ersetzt wird
  (nichts wird angelegt, umbenannt oder gelöscht, und nichts wird in den Ordner
  einer CLI geschrieben); und die Notizen eines eigenen Branches, die in den
  Hauptordner zurückgehen, wenn Sie den Branch entfernen oder integrieren. Hat
  sich eine Notiz auf beiden Seiten geändert, werden die beiden Versionen so
  zusammengeführt, wie git Code zusammenführt, und Sie entscheiden nur dort, wo
  beide dieselben Zeilen geändert haben.

</details>

![Eine Datei aus dem Baum in der Vorschau, mit Syntaxhervorhebung](assets/captura-archivos.png)

---

## Fehlerbehebung

**„Der Befehl ‚claude‘ wurde im PATH nicht gefunden“, gefolgt von „Funktioniert
auch mit: …“** – die App hat keine der CLIs gefunden. Prüfen Sie das mit
`where claude` unter Windows (`which claude` auf anderen Systemen) und ebenso mit
`codex`, `opencode`, `agy` oder `pi`. Die CLIs werden beim Start gesucht: Wenn Sie
eine installiert haben, während die App offen war, starten Sie die App neu.

**Pi ist installiert, aber die App sieht es nicht.** Die App führt `pi` nicht
aus, um es zu finden: Sie liest die Version aus dem Paket von Pi, neben dem
Befehl. Das funktioniert, wenn Pi mit npm oder mit dem Installer von pi.dev
installiert wurde; eine eigenständige `pi`-Binärdatei wird nicht erkannt. Und
wenn in Ihrem `PATH` zuerst ein anderes Programm namens `pi` steht, ignoriert
die App es und sagt das in ihrer Konsole.

**In einem Pi-Tab meldet das Eingabefeld, dass die CLI auf eine Antwort von
Ihnen wartet.** Pi fragt, ob es dem Projektordner vertrauen soll. Beantworten
Sie die Frage im Tab **CLI**: Die App beantwortet sie nie für Sie.

**Die Historie von OpenCode erscheint nicht.** Achten Sie beim Start der App auf
die Zeile `History`. Steht dort, dass diese Node-Version `node:sqlite` nicht
enthält, aktualisieren Sie Node auf 22.13 oder neuer. Fehlt die Zeile, hat die
App die Datenbank nicht gefunden: Sie liegt unter
`~/.local/share/opencode/opencode.db` oder dort, wohin `OPENCODE_DB` oder
`XDG_DATA_HOME` zeigt.

**Ein OpenCode-Tab öffnet sich nicht: „Couldn't start the OpenCode server“.** Der
Grund steht nach dem Doppelpunkt. Ist er nicht klar, starten Sie `opencode` in
einem normalen Terminal: Startet es auch dort nicht, liegt das Problem an dieser
OpenCode-Installation.

**Ein OpenCode-Tab meldet, dass der Server beendet wurde.** **Neu starten** in
derselben Leiste startet einen neuen Server und verbindet den Tab wieder mit
derselben Sitzung.

**Die Limits Ihres Plans erscheinen bei Claude Code nicht.** Bietet die Anzeige
**Konfigurieren** an, folgen Sie
[diesen Schritten](#claude-code-nutzungslimits-ihres-plans). Steht dort
**keine Daten**, ist die Statuszeile konfiguriert, hat die Limits aber noch
nicht veröffentlicht: Sie kommen mit der ersten Antwort jeder Sitzung und nur
bei einem Abonnement-Plan.

**Ein Antigravity-Tab zeigt weder seinen Status noch die Kontextanzeige.**
Achten Sie beim Start der App auf den Eintrag `Status line` unter der CLI. Steht
dort, dass sie nicht konfiguriert ist oder dass es eine andere gibt, folgen Sie
[diesen Schritten](#antigravity-cli-status-und-kontextanzeige). Wenn Sie sie
konfiguriert haben und das Terminal der CLI `Statusline Error` zeigt, ist `node`
höchstwahrscheinlich nicht im `PATH` dieser Sitzung.

**`node-pty` lässt sich bei der Installation nicht kompilieren.** Das ist das
native Modul des Terminals. Normalerweise wird eine fertige Binärdatei
heruntergeladen; gibt es für Ihre Node-Version und Plattform keine, muss es
kompiliert werden:

- **Windows:** Visual Studio Build Tools mit der Workload
  *Desktopentwicklung mit C++* und Python 3. (`windows-build-tools` aus npm wird
  nicht mehr gepflegt.)
- **macOS:** `xcode-select --install`.
- **Linux:** `build-essential` und `python3`.

**Das Terminal bleibt leer.** Der Standard-Renderer ist absichtlich Canvas: Mit
WebGL friert der Tab unter Windows 11 + Chrome ein. Um WebGL trotzdem
auszuprobieren, hängen Sie `?renderer=webgl` an die Adresse an.

**Ein Hinweis meldet, dass `CLAUDE_CODE_CHILD_SESSION` entfernt wurde.** Sie
haben die App aus einer Sitzung von Claude Code heraus gestartet. Diese Variable
schaltet das Speichern der Historie ab, daher entfernt die App sie und sagt es
Ihnen. Aus einem normalen Terminal heraus sehen Sie das nie.

**Vom anderen Computer aus kann `ssh` keine Verbindung herstellen**
(Zeitüberschreitung oder Ablehnung). Auf dem Computer mit der App läuft der
SSH-Server nicht, oder etwas zwischen den beiden blockiert ihn. Prüfen Sie unter
Windows, ob das WLAN als *Privat* eingestellt ist: Die Firewall-Regel des
SSH-Servers gilt möglicherweise nicht für Netzwerke vom Typ *Öffentlich*. Ein
Firmen-VPN, das das lokale Netzwerk sperrt, unterbricht die Verbindung
ebenfalls, solange es verbunden ist. Wenn `ssh` Ihren Benutzer ablehnt, braucht
ein Microsoft- oder Firmenkonto möglicherweise den Namen Ihres Benutzerordners
(`C:\Users\<name>`) und das Kontopasswort, nicht die PIN.

**Vom anderen Computer aus zeigt die Seite „Origin not allowed“** (403). Sie
wurde über den Namen oder die IP-Adresse des Computers geöffnet. Öffnen Sie
`http://localhost:<port>`, mit einem Tunnel, der auf beiden Seiten denselben
Port verwendet.

**Vom anderen Computer aus meldet die Seite, dass das Sitzungstoken fehlt**
(401). Dieser Browser ist nicht gekoppelt, er wurde widerrufen, oder der
Fernzugriff ist ausgeschaltet. Koppeln Sie ihn erneut über den Dialog ⇄.

**Der Dialog ⇄ meldet, dass der Port belegt ist.** Ein anderes Programm – oft
ein zweites Agent Workbench – verwendet ihn. Schließen Sie es und starten Sie
neu, oder wählen Sie einen anderen Port.

**Das Panel „Änderungen“ meldet, dass der Ordner kein git-Repository ist**,
obwohl er eines ist. Stellen Sie sicher, dass `git` im `PATH` ist. Lautet die
Meldung anders, ist es die Fehlermeldung von git selbst, Wort für Wort.

---

## Aus dem Quellcode

Um an der App zu arbeiten, oder wenn Sie lieber nichts global installieren
möchten:

```bash
corepack enable pnpm
pnpm install
pnpm dev       # mit Hot Reload
```

```bash
pnpm build     # baut die Oberfläche einmal
pnpm start     # liefert die gebaute Oberfläche aus
```

**Start mit einem Klick unter Windows:** `pnpm package` baut die Oberfläche und
legt eine **`Agent Workbench.cmd`** im Stammverzeichnis ab. Ein Doppelklick
darauf installiert, was fehlt, baut bei Bedarf und öffnet den Browser. Es ist
eine Textdatei mit zwanzig Zeilen, die Sie vor dem Ausführen lesen können.

---

## So ist es aufgebaut

Ein pnpm-Monorepo, durchgehend in TypeScript.

```
packages/
  server/    Node, Express, ws, node-pty, chokidar — serves the interface and runs the terminals
    src/agents/   one adapter per CLI: the only part of the server that knows each one
  web/       Vite, React, xterm.js, highlight.js
  shared/    the protocol types, with no `any` at the edges
android/     the Android app, in Kotlin: the SSH tunnel, the interface, the notifications
```

Zwei Entscheidungen prägen den Rest. **Die Terminals leben auf dem Server, und
der Browser ist nur ein Fenster darauf**: Das Schließen oder Neuladen der Seite
beendet keine laufende Sitzung. Und **der generische Server nennt keine CLI beim
Namen**: Was er über jede weiß – wo sie ihre Daten ablegt, wie sie gestartet
wird, was gelesen und was nie geöffnet wird –, steckt im Adapter dieser CLI, und
die Oberfläche zeigt jedes Bedienelement abhängig davon, was diese CLI
deklariert.

[`ARCHITECTURE.md`](ARCHITECTURE.md) enthält die festen Regeln und die Übersicht
über den Code, [`CONTRIBUTING.md`](CONTRIBUTING.md) erklärt, wie man am
Repository arbeitet, [`SECURITY.md`](SECURITY.md), wie man eine Sicherheitslücke
meldet, [`PRIVACY.md`](PRIVACY.md), was erfasst wird (nichts), und
[`CHANGELOG.md`](CHANGELOG.md), was sich in jeder Version geändert hat (alle auf
Englisch). Die Kommentare im Code sind auf Spanisch. Die Screenshots in diesem
README stammen aus `pnpm demo:shots`, mit erfundenen Daten.

---

## Das Projekt unterstützen

Wenn Agent Workbench für Sie nützlich ist, überlegen Sie, das Projekt zu
unterstützen: [Buy Me a Coffee](https://buymeacoffee.com/cvelasquez). Die App
schlägt das einmal pro Version vor, in einer Leiste, die Sie schließen können,
und dann erst wieder mit der nächsten Version.

---

## Lizenz

MIT. Siehe [`LICENSE`](LICENSE).

Agent Workbench ist ein unabhängiges Projekt. Es funktioniert mit den CLIs von
Claude Code, Codex, OpenCode, Antigravity und Pi, steht aber in keiner
Verbindung zu Anthropic, OpenAI, den Autoren von OpenCode, Google oder Earendil
und wird von ihnen auch nicht befürwortet.
