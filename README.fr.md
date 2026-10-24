# Agent Workbench

[![npm](https://img.shields.io/npm/v/agent-workbench)](https://www.npmjs.com/package/agent-workbench)
[![CI](https://github.com/cvelasquez/agent-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/cvelasquez/agent-workbench/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/agent-workbench)](LICENSE)
[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge.svg)](https://github.com/hesreallyhim/awesome-claude-code)

[English](README.md) · [Español](README.es.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · **Français** · [Deutsch](README.de.md)

**Un atelier visuel pour les agents de code que vous utilisez déjà : les CLI de
Claude Code, Codex, OpenCode, Antigravity et Pi.** Il tourne sur votre ordinateur
et s'ouvre dans votre navigateur. Il utilise les CLI que vous avez déjà installées
et connectées à votre compte, ne touche jamais à vos identifiants et ne fait
aucun appel réseau de son propre chef.

```bash
npx agent-workbench
```

![Visite guidée : la conversation en cartes, les fichiers modifiés et un diff, un onglet par CLI, et la suite d'une conversation avec une autre CLI](assets/demo.webp)

## Comment ça marche

Agent Workbench ne communique avec aucun service d'IA. Il lance la CLI que vous
avez déjà — `claude`, `codex`, `opencode`, `agy` ou `pi` — dans un vrai terminal,
et ajoute autour ce qu'un terminal seul ne vous donne pas : des onglets, vos
conversations passées, la conversation sous forme de cartes faciles à lire, une
jauge de contexte, les fichiers modifiés et une arborescence de fichiers.

Le terminal reste le terminal : tout ce que vous tapez va directement à la CLI.

---

## Ce que vous y trouvez

| | |
|---|---|
| **Onglets** | Plusieurs agents à la fois, de n'importe quelle CLI, chacun dans son dossier. Un point sur chaque onglet indique si l'agent travaille, s'il est au repos ou s'il vous attend. Recharger la page n'arrête rien : les CLI tournent sur le serveur, pas dans le navigateur. |
| **Démarrage rapide** | Quand vous ouvrez l'application, vos onglets reviennent **en veille** : vous pouvez les lire en entier, et aucune CLI ne démarre tant que vous ne cliquez pas sur **Ouvrir la CLI**. |
| **Historique** | Vos projets et vos conversations passées dans la barre latérale, de toutes les CLI, avec un filtre. Cliquez sur une conversation pour la reprendre là où vous l'aviez laissée, avec sa CLI. Archivez les anciennes sessions ou un projet entier pour faire le ménage : rien n'est supprimé, et c'est réversible. |
| **Conversation** | Les messages sous forme de cartes, en direct, avec les appels d'outils repliés. Les messages plus anciens se chargent quand vous remontez. Recherchez, copiez n'importe quel message ou bloc de code, et revenez à votre message précédent (↑) ou allez à la fin (↓). Une ligne en bas indique quand votre message a été remis à la CLI et si l'agent travaille encore. Selon la CLI, vous pouvez répondre aux questions de l'agent directement dans la conversation. Un fichier du projet que l'agent mentionne s'ouvre dans l'onglet Fichiers en un clic, et un dossier, dans l'explorateur de fichiers du système. Avec Claude Code, un message que vous arrêtez avant que l'agent commence revient dans la zone de saisie pour le corriger, et **↩** sur un message revient avant lui : la conversation et, si vous le voulez, le code. Un message envoyé pendant que l'agent travaille attend à la fin, marqué en file d'attente ; selon la CLI, **Forcer l'envoi maintenant** le fait lire tout de suite à l'agent, et **Modifier** (ou ↑ dans la zone de saisie vide) le ramène dans la zone de saisie pour le corriger. |
| **Zone de saisie** | De la place pour écrire, coller des images, joindre des fichiers, et les longs textes collés rangés dans une pastille compacte. Ce que vous êtes en train d'écrire survit à la fermeture de l'application et s'affiche en direct dans toutes les fenêtres ouvertes. Maj+Entrée continue une liste numérotée ou à puces. |
| **Jauge de contexte** | La part de la fenêtre de contexte du modèle qu'occupe la conversation. En tokens, jamais en argent. À partir de 70 %, **Compacter** demande à la CLI de compacter la conversation. À côté, avec Claude Code, Codex et Antigravity CLI, la part des limites d'utilisation de votre forfait que vous avez consommée et quand elles se réinitialisent. |
| **Modifications** | La branche, les fichiers modifiés et leur diff. **Orchestre des agents en parallèle** : ouvrez le projet sur une nouvelle branche, dans son propre dossier, et plusieurs agents travaillent en même temps sans se marcher sur leurs modifications. Modifications montre chaque branche : ce qui n'est pas encore commité, combien de commits elle a et si elle est déjà intégrée. Une autre CLI relit une branche sans la toucher, et vous l'intégrez dans main en un clic. |
| **Fichiers** | L'arborescence du projet, avec une recherche et un aperçu avec coloration syntaxique. Ouvrez plusieurs fichiers à la fois, chacun dans son onglet ; les fichiers Markdown s'ouvrent mis en forme. Un clic place le chemin d'un fichier dans votre message. Modifiez un fichier texte, un `.env` par exemple, et enregistrez-le sur place : si l'agent l'a changé pendant que vous le modifiiez, rien n'est écrasé, et vous reportez vos modifications dans la nouvelle version. |
| **Plans** | Les plans et les documents `.md` que la conversation a écrits, mis en forme. Un clic place le chemin d'un document dans votre message. |
| **Notes** | Un bloc-notes à côté de la conversation, images comprises. Avec Claude Code, un clic envoie une note dans une nouvelle conversation. |
| **Console** | Le terminal de votre système, en bas, dans le dossier du projet : PowerShell, cmd ou Git Bash sous Windows ; bash ou zsh sous macOS et Linux. |
| **Continuer avec…** | Avec plus d'une CLI, poursuivez une conversation avec une autre CLI, dans le même dossier. Le nouvel agent repart d'une transcription des derniers tours. |
| **Notifications** | Un son, et en option des notifications système, quand un agent a terminé ou vous attend. |
| **Réglages** | ⚙ dans l'en-tête : la langue, le thème du terminal, les panneaux affichés, la console qui s'ouvre et les CLI qu'utilise l'application. |
| **Neuf langues** | English, Español, 简体中文, 日本語, Português (Brasil), Русский, 한국어, Français et Deutsch. L'interface suit la langue de votre navigateur. |
| **Thème** | Clair, sombre ou celui du système. Le terminal reste sombre par défaut, pour que les couleurs des CLI restent lisibles. |

En option, et désactivés par défaut : une [mémoire partagée](#mémoire-partagée-entre-les-cli)
entre les CLI, une [sauvegarde](#sauvegarde-de-votre-historique) de votre
historique, les [limites d'utilisation du forfait](#limites-dutilisation-du-forfait-de-claude-code)
de Claude Code, l'[accès à distance](#accès-à-distance-par-ssh) depuis un autre
ordinateur ou un téléphone, et une [application Android](#lapplication-android).

<p>
  <img src="assets/captura-cambios.png" width="49%" alt="Le panneau Modifications : la branche et les fichiers modifiés, par groupe">
  <img src="assets/captura-diff.png" width="49%" alt="Le diff de l'un de ces fichiers, dans le même panneau">
</p>

### Avec plus d'une CLI

Chaque session et chaque onglet affichent un petit badge avec leur CLI, et le
bouton `+` qui ouvre un nouvel onglet vous laisse choisir quelle CLI lancer. Avec une
seule CLI, vous ne voyez rien de tout cela.

<img src="assets/captura-clis.png" width="45%" alt="La barre latérale des projets avec des sessions de plusieurs CLI, chacune avec son badge, et le menu + avec les cinq CLI et leurs versions">

**Toutes les CLI ne partagent pas les mêmes informations**, si bien que
quelques fonctions dépendent de la CLI :

| | Claude Code | Codex | OpenCode | Antigravity CLI | Pi |
|---|:---:|:---:|:---:|:---:|:---:|
| Point de l'onglet : travaille, au repos, vous attend | ✓ | — | ✓ ¹ | ✓ ² | ✓ |
| Répondre aux questions de l'agent depuis la conversation | ✓ | — | ✓ ¹ | — | — |
| Jauge de contexte | ✓ | ✓ | ✓ | ✓ ² | ✓ |
| Sélecteurs de mode et de modèle | ✓ | — | — | ✓ | ✓ ³ |
| Coller des images | ✓ | ✓ | ✓ | — | ✓ ³ |
| Onglet Plans | ✓ | — | — | — | — |
| Envoyer une note dans une nouvelle conversation | ✓ | — | — | — | — |

Pour le reste, le terminal de la CLI est toujours là : là où il y a un « — »,
c'est par exemple dans ce terminal que vous répondez aux questions.

¹ Avec OpenCode, l'application lance un serveur OpenCode local pour obtenir ces
informations ([détails](#vos-données-et-la-sécurité)).
² Seulement si vous configurez sa status line
([comment](#état-et-jauge-de-contexte-dantigravity-cli)).
³ Pi n'a pas de modes de permissions : ses sélecteurs sont ceux du modèle et du
niveau de réflexion. Et il ne joint pas ce que vous collez : une image voyage
sous la forme d'un chemin de fichier que le modèle ouvre lui-même.

---

## Prérequis

- **Node.js 20 ou plus récent.** Pour voir l'historique d'OpenCode et les titres
  des conversations d'Antigravity CLI, **22.13 ou plus récent** : ils sont lus
  avec le SQLite intégré à Node depuis cette version. Avec une version plus
  ancienne, tout le reste fonctionne.
- **git**, pour le panneau Modifications. Tout le reste fonctionne sans.
- **Au moins une CLI**, installée et connectée à votre compte :

| CLI | Commande | Installation |
|---|---|---|
| Claude Code | `claude` | [guide d'installation](https://docs.claude.com/en/docs/claude-code/setup) |
| Codex | `codex` | [guide](https://learn.chatgpt.com/docs/codex/cli) |
| OpenCode | `opencode` | [documentation](https://opencode.ai/docs/) |
| Antigravity CLI | `agy` | [guide](https://antigravity.google/docs/cli/getting-started) |
| Pi | `pi` | [pi.dev](https://pi.dev) |

Agent Workbench n'inclut et ne télécharge aucune CLI : il trouve celles qui
sont dans votre `PATH`. S'il n'y en a aucune, il vous le dit et n'ouvre pas de
session.

**Plateformes.** Développé et utilisé tous les jours sous Windows 11 avec
PowerShell. Sous macOS et Linux, chaque modification est installée et lancée
automatiquement, mais ces systèmes servent moins au quotidien : les retours
sont les bienvenus. Sous Linux, l'installation compile le module du terminal :
il vous faut donc `python3`, `make` et un compilateur C++ (`build-essential`
sur Debian et Ubuntu).

---

## Installer et lancer

```bash
npm install -g agent-workbench
```

Ensuite, depuis le dossier du projet sur lequel vous voulez travailler :

```bash
agent-workbench
```

Votre navigateur s'ouvre sur une adresse comme celle-ci :

```
  URL          http://127.0.0.1:52341/?token=…
```

Cette adresse est la seule porte d'entrée : le jeton change à chaque
démarrage, et l'application n'écoute que sur votre propre ordinateur
(`127.0.0.1`).

Pour l'essayer une fois sans l'installer : `npx agent-workbench`. La première
fois, cela télécharge environ 60 Mo, surtout le module natif du terminal. Pour
un usage quotidien, l'installation globale est préférable.

---

## Raccourcis clavier

| Touches | Action |
|---|---|
| `Alt+T` | Nouvel onglet |
| `Alt+W` | Fermer l'onglet |
| `Alt+←` / `Alt+→` (ou `Alt+PgUp` / `Alt+PgDn`) | Onglet précédent / suivant |
| `Alt+P` | Afficher ou masquer le panneau de droite |
| `Shift+Tab`, hors du terminal | Revenir à l'onglet précédent |

Le bouton `?` de l'en-tête les liste tous, ainsi que les raccourcis propres à
la CLI active. Ils utilisent `Alt` parce que le navigateur se réserve `Ctrl+T`,
`Ctrl+W` et `Ctrl+Tab` pour ses propres onglets et ne les transmet jamais à la
page.

Toutes les autres touches — `Esc`, `Ctrl+C`, `Ctrl+R`, `Ctrl+O`, les flèches,
`Alt+V` pour coller des images — arrivent intactes à la CLI. `Ctrl+V` aussi :
ce qu'il y fait dépend de la CLI. Ce n'est que dans la console du bas, sous
Windows, que `Ctrl+V` colle du texte, comme dans Windows Terminal.

---

## Fonctions optionnelles

### Mémoire partagée entre les CLI

Chaque CLI garde ce qu'elle apprend sur un projet dans son coin, et les autres
ne le voient pas. L'onglet **Mémoire** met en place une seule mémoire pour
toutes : des notes dans le dossier `.agents/memory/` du projet, que chaque CLI
lit et écrit — d'ici ou depuis son propre terminal — via `AGENTS.md` et
`CLAUDE.md`. L'onglet est masqué au départ : affichez-le depuis ⚙ Réglages.

**Prévisualiser les modifications** montre, fichier par fichier, ce qui serait
écrit, et rien n'est touché tant que vous n'avez pas confirmé. La mise en place
importe la mémoire que Claude Code avait déjà pour ce projet. L'application ne
modifie pas la configuration globale de chaque CLI : elle vous donne l'extrait
à coller vous-même.

<img src="assets/captura-memoria.png" width="70%" alt="L'onglet Mémoire avec le pont installé pour les cinq CLI et les notes importées">

### Sauvegarde de votre historique

Chaque CLI gère son propre historique : elle peut en changer le format,
l'élaguer ou être désinstallée. La sauvegarde conserve une copie de vos
conversations — messages, appels d'outils et leurs résultats, images, et la
mémoire de chaque projet — dans un dossier à vous, dans des fichiers lisibles
sans l'application.

**Elle est désactivée par défaut.** Ouvrez-la avec le bouton de la sauvegarde,
en haut de la barre latérale des projets, ou depuis ⚙ Réglages. **Mesurer**
vous indique l'espace qu'elle occuperait par CLI, sans rien écrire, et
**Activer** la démarre. Dès lors, elle copie tout ce qui figure dans la barre
latérale sans être archivé, et recopie une conversation une minute après
qu'elle a cessé de changer. Elle ne supprime jamais rien dans ce dossier.

Avec la sauvegarde activée :

- Les conversations qu'une CLI n'a plus restent dans la barre latérale,
  marquées « sauvegarde », et s'ouvrent en Markdown.
- N'importe quel projet peut être exporté en Markdown.
- Avec plus d'une CLI, le filtre de la barre latérale peut chercher
  **Dans les conversations** : le texte de tout ce qui a été copié, de toutes
  les CLI.

<img src="assets/captura-buscador.png" width="40%" alt="Recherche dans les conversations : un résultat dans une session de chaque CLI, avec son extrait">

Par défaut, elle se trouve dans le dossier de configuration de l'application
(`%APPDATA%\agent-workbench\vault` sous Windows). **Changer de dossier…** la
copie dans un autre — un dossier synchronisé, un autre disque — sans rien
écraser, et laisse l'ancien tel quel. Si vous la placez dans un dossier
synchronisé ou dans un dépôt, vos conversations voyagent avec elle.

<details>
<summary>Importer l'historique de Gemini CLI et d'Antigravity IDE</summary>

Deux importateurs à usage unique récupèrent l'historique d'outils que
l'application ne lit pas. Ils se lancent depuis le code source
([plus bas](#depuis-le-code-source)) et **n'écrivent rien sans `--write`** :
sans cette option, ils vous disent seulement ce qu'ils importeraient.

- `pnpm vault:import gemini-cli [--cwd <folder>]` — les chats laissés par
  Gemini CLI. `--cwd` est le dossier où vous l'utilisiez, pour les classer sous
  ce projet.
- `pnpm vault:import antigravity-ide --workspace <folder>` — ce qui peut être
  lu des conversations d'Antigravity IDE dans ce dossier : le résumé de chacune
  et ses documents `.md`. La conversation elle-même est chiffrée : elle est
  donc marquée comme historique partiel.

</details>

### Limites d'utilisation du forfait de Claude Code

Claude Code n'indique que par sa *status line* quelle part des limites
d'utilisation de votre forfait vous avez consommée (la fenêtre de 5 heures et
la semaine). Pour les voir à côté de la jauge de contexte :

1. Ouvrez un onglet Claude Code et cliquez sur **Configurer**, à côté de la
   jauge.
2. Copiez la ligne affichée et ajoutez-la à ce que contient déjà
   `~/.claude/settings.json`. L'application ne touche pas à ce fichier : c'est
   vous qui le modifiez.
3. En quelques secondes, ou avec **Vérifier**, la boîte de dialogue indique
   **Configurée**. Les limites apparaissent avec la réponse suivante.

Claude Code n'accepte qu'une seule status line : celle-ci remplace donc toute
autre que vous auriez, et avec elle la CLI n'affiche plus certaines aides en bas
de son écran, comme « esc to interrupt ». La ligne exécute un petit script rangé
dans le dossier de l'application : il n'enregistre que les deux limites et
l'identifiant de la session, et les affiche sur une ligne courte en bas de la
CLI. Le script s'exécute dans **chaque** session `claude`, y compris celles que
vous ouvrez hors de l'application, et il a besoin de `node` dans le `PATH`.
Claude Code ne publie ces limites qu'avec un forfait d'abonnement, pas avec une
clé d'API.

Codex n'a besoin de rien : il écrit ses limites dans son propre historique.
Antigravity CLI les indique par sa status line, décrite ci-dessous. OpenCode et
Pi ne les publient pas.

### État et jauge de contexte d'Antigravity CLI

Antigravity CLI n'indique si elle travaille ou vous attend, combien de tokens
elle a utilisés et ce qu'il reste de votre quota, que par sa *status line*. Sans
elle, ses onglets fonctionnent normalement, mais le point de l'onglet indique un
état inconnu et les jauges restent vides. Pour l'activer :

1. Ouvrez un onglet Antigravity et cliquez sur **Configurer**, à côté de la
   jauge.
2. Copiez la ligne affichée et ajoutez-la à ce que contient déjà
   `~/.gemini/antigravity-cli/settings.json`. L'application ne touche pas à ce
   fichier : c'est vous qui le modifiez.
3. En quelques secondes, ou avec **Vérifier**, la boîte de dialogue indique
   **Configurée**.

La ligne exécute un petit script rangé dans le dossier de l'application. Il
n'enregistre que l'état, le mode, le modèle et les tokens de chaque
conversation et, de votre quota, ce qu'il en reste et quand il se
réinitialise. Il n'enregistre ni votre e-mail, ni votre forfait, ni le coût,
que la CLI lui transmet aussi, et il n'affiche rien : la status line propre à
la CLI reste donc telle quelle. Une fois en place, elle s'exécute dans **chaque**
session `agy`, y compris celles que vous ouvrez hors de l'application, et elle
a besoin de `node` dans le `PATH`.

### Accès à distance par SSH

Laissez Agent Workbench tourner sur un ordinateur et utilisez-le depuis un
autre de votre réseau, dans son navigateur, sans aucune CLI installée dessus.
**L'application n'est jamais ouverte au réseau** : elle n'écoute toujours que
sur `127.0.0.1`, et l'autre ordinateur l'atteint par un tunnel SSH. C'est aussi
le tunnel qui fait que ça marche : à travers lui, l'autre navigateur voit
l'application comme `localhost`, ce que les navigateurs exigent pour le
presse-papiers et les notifications. **C'est désactivé par défaut.**

**1. Sur l'ordinateur qui fait tourner l'application, une fois : activez son
serveur SSH.** C'est une modification du système qui demande les droits
d'administrateur : l'application ne le fait donc pas à votre place.

- **Windows 10/11** — dans PowerShell *en tant qu'administrateur*. La première
  ligne télécharge et installe le serveur, ce qui prend quelques minutes :
  attendez le retour de l'invite.

  ```powershell
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
  Start-Service sshd
  Set-Service -Name sshd -StartupType Automatic
  ```

- **macOS** — Réglages Système → Général → Partage → **Session à distance**.
- **Linux** — installez et activez le serveur OpenSSH de votre distribution.
  Sur Debian ou Ubuntu :

  ```bash
  sudo apt install openssh-server
  sudo systemctl enable --now ssh
  ```

**2. Dans l'application : ⇄ dans l'en-tête → Activer l'accès à distance, puis
redémarrez Agent Workbench.** Le tunnel a besoin d'un port qui ne change pas :
l'application en utilise donc un fixe (24837 par défaut ; vous pouvez le
changer), et le port est choisi au démarrage. Le redémarrage ferme les CLI
ouvertes ; vos onglets reviennent en veille. La *désactivation*, elle, prend
effet immédiatement.

**3. Sur l'autre ordinateur, à chaque utilisation : ouvrez le tunnel.** La
boîte de dialogue affiche la commande, prête à copier :

```
ssh -N -L 24837:127.0.0.1:24837 you@your-computer
```

Laissez-la tourner, et **utilisez le même port aux deux bouts** : avec un port
local différent, l'application répond 403. Ajouter
`-o ServerAliveInterval=30 -o ExitOnForwardFailure=yes` permet au tunnel de
remarquer une coupure du Wi‑Fi au lieu de rester bloqué. Sous Windows, vous
pouvez enregistrer la commande dans un fichier `.cmd` et double-cliquer
dessus.

**4. Associez cet ordinateur, une fois.** Dans la boîte de dialogue,
**Associer un appareil** vous donne une adresse avec un code à usage unique,
comme `http://localhost:24837/?pair=K7QM-X2RD`. Ouvrez-la dans le navigateur de
l'autre ordinateur dans les cinq minutes. Ensuite, ce navigateur ouvre
simplement `http://localhost:24837`, même après un redémarrage de
l'application. La boîte de dialogue liste les appareils associés, et
**Révoquer** en coupe un immédiatement.

Un appareil associé peut utiliser toute l'application, sauf la gestion de
l'accès à distance et les quelques actions qui ouvriraient une fenêtre sur
l'ordinateur hôte, comme *Ouvrir avec l'application par défaut*. Un badge
**À distance** dans l'en-tête le signale. Gardez à l'esprit que l'application
inclut une console et lance des agents : un appareil associé peut donc
exécuter des commandes sur votre ordinateur, tout comme vous.
**N'associez que vos propres appareils.**

**Sur un téléphone ou une tablette.** Par le même tunnel, le navigateur d'un
téléphone reçoit une mise en page sur une seule colonne : la barre latérale des
projets glisse depuis le bord, les onglets se trouvent dans l'en-tête, et une
bande permet de passer de la conversation à la CLI, aux modifications, aux
fichiers et au reste. Elle apparaît sur toute fenêtre de moins de 768 px de
large. Sur un écran tactile, Enter dans la zone de saisie insère un saut de
ligne (c'est le bouton d'envoi qui envoie), et faire glisser un doigt sur un
terminal le fait défiler.

<details>
<summary>Une clé SSH plus sûre, valable uniquement pour le tunnel (recommandé)</summary>

La connexion SSH se fait avec votre utilisateur sur cet ordinateur : un mot de
passe ou une clé qui ouvre le tunnel y ouvre donc aussi un terminal complet.
Vous pouvez créer une clé valable uniquement pour le tunnel : générez-en une
sur l'autre ordinateur (`ssh-keygen -t ed25519`) et ajoutez sa partie publique
à `authorized_keys` sur l'ordinateur qui fait tourner l'application, précédée
de ces options :

```
restrict,port-forwarding,permitopen="127.0.0.1:24837",command="exit" ssh-ed25519 AAAA… other-computer
```

`restrict` seul laisse encore la clé exécuter des commandes ; c'est
`command="exit"` qui ferme cette porte, et le tunnel ne demande jamais de
commande. Sous Windows, si votre utilisateur est administrateur, ce fichier est
`C:\ProgramData\ssh\administrators_authorized_keys`, et seuls Administrateurs
et SYSTEM doivent pouvoir y écrire ; sinon, c'est
`%USERPROFILE%\.ssh\authorized_keys`. Pour le vérifier, essayez
`ssh you@your-computer whoami` avec cette clé : la commande ne doit rien
afficher et se terminer aussitôt, alors que le tunnel `-N -L` continue de
fonctionner.

</details>

### L'application Android

Une application pour Android 10 et versions ultérieures ouvre le tunnel pour
vous et affiche la même interface, servie par votre ordinateur, avec la mise en
page pour téléphone. Elle reste connectée en arrière-plan et vous prévient
quand un agent a terminé ou vous attend, même écran éteint ; toucher une
notification ouvre l'onglet concerné. Quand le Wi‑Fi revient, elle se
reconnecte toute seule.

Elle a besoin de l'accès à distance activé et du serveur SSH de l'ordinateur en
marche (étapes 1 et 2 ci-dessus). Téléchargez-la sur
[Google Play](https://play.google.com/store/apps/details?id=io.github.cvelasquez.agentworkbench),
ou compilez-la vous-même depuis [`android/`](android/) comme l'explique
[`CONTRIBUTING.md`](CONTRIBUTING.md#the-android-app).

**Association, une fois :**

1. Dans la boîte de dialogue ⇄, choisissez **Associer un téléphone**. Elle
   affiche une ligne à coller dans un terminal de cet ordinateur, et un code
   QR. Sous Windows, si votre utilisateur est administrateur, la ligne se colle
   dans PowerShell *en tant qu'administrateur* ; la boîte de dialogue vous le
   précise.
2. Collez la ligne. Elle autorise la clé du téléphone pour le tunnel
   uniquement : avec elle, le téléphone atteint l'application et rien
   d'autre — ni terminal ni commandes.
3. Scannez le code QR avec l'application. Le code ne sert qu'une fois et reste
   valable cinq minutes, et la boîte de dialogue doit rester ouverte jusqu'à ce
   que le téléphone se connecte.

Le code QR contient la clé SSH privée du téléphone. Votre ordinateur ne la
garde qu'en mémoire jusqu'à ce que le téléphone l'utilise et ne l'écrit jamais
sur le disque : **ne partagez pas de photo de ce code QR**. Le téléphone
mémorise l'empreinte SSH de votre ordinateur à la première connexion et, si
elle change un jour, il refuse de se connecter et vous prévient.

**Pour retirer un téléphone**, cliquez sur **Révoquer** dans la boîte de
dialogue et supprimez sa ligne de `authorized_keys` (elle se termine par
`agent-workbench-phone`). Sur le téléphone,
**Réglages → Oublier cet ordinateur** supprime sa clé et ses identifiants.

Si les notifications arrivent en retard quand le téléphone est au repos,
laissez l'application fonctionner sans restriction de batterie :
**Réglages → Ouvrir les réglages de batterie de l'application**. Ce que
l'application garde sur le téléphone et les autorisations qu'elle demande sont
décrits dans [`PRIVACY.md`](PRIVACY.md).

---

## Vos données et la sécurité

- **Agent Workbench n'envoie rien nulle part.** Pas de télémétrie, pas
  d'analytique, aucun appel réseau de sa part. L'application Android ne parle
  qu'à votre ordinateur.
- **Chaque CLI continue de faire, de son côté, ce qu'elle ferait si vous
  l'ouvriez à la main :** elle parle à son fournisseur d'IA, et elle peut
  vérifier s'il existe des mises à jour ou envoyer ses propres données
  d'utilisation. Agent Workbench n'y ajoute rien et n'en désactive rien non
  plus : il ne modifie la configuration d'aucune CLI. Ce qu'envoie chaque CLI
  est décrit dans sa propre documentation.
- **L'application ne touche jamais à vos identifiants.** Il n'y a pas d'écran
  de connexion : si une CLI vous demande de vous connecter, vous le faites dans
  son propre terminal, et l'application ne s'en aperçoit même pas.
- **Elle lit l'historique des CLI et n'écrit rien dans leurs dossiers.** Le
  tableau ci-dessous liste ce qu'elle lit et ce qu'elle n'ouvre jamais.
- **Elle n'écrit que dans ses propres dossiers**, plus trois choses dans vos
  projets : la mémoire partagée, seulement si vous le confirmez ; un fichier que
  vous modifiez et enregistrez vous-même dans l'onglet Fichiers ; et les
  branches à part que vous ouvrez, chacune dans son dossier à côté du projet,
  avec les notes qui reviennent au dossier principal quand vous la retirez ou
  l'intégrez.
- **Le serveur n'écoute que sur votre ordinateur** (`127.0.0.1`), sur un port
  aléatoire, avec un nouveau jeton aléatoire à chaque démarrage, et il rejette
  les requêtes venant d'autres pages web. L'accès à distance n'y change rien :
  le port devient fixe, toujours sur `127.0.0.1`, et SSH — que vous activez et
  contrôlez — fait le reste.
- **Git : l'application ne fait jamais de commit ni de push, et ne réécrit pas
  l'historique.** Elle exécute quatre commandes git qui écrivent, chacune après
  une confirmation qui l'affiche : `git worktree add` pour ouvrir une branche
  dans son propre dossier, `git worktree remove` (jamais avec `--force`),
  `git branch -d` (seulement pour une branche créée par l'application et déjà
  intégrée) et `git merge --ff-only` pour intégrer une branche dans main sans
  créer de commit. Quand vous retirez une branche, l'application ne supprime
  elle-même des fichiers que dans deux cas : les nouveaux fichiers que la boîte
  de dialogue a listés, si vous choisissez de les perdre, et ce que git laisse
  du dossier de la branche quand il n'arrive pas à finir de le supprimer. Les
  commits, ce sont les agents qui les font, dans leur terminal.

| CLI | Ce qui est lu | Ce qui n'est jamais ouvert |
|---|---|---|
| Claude Code | Dans `~/.claude/` : `projects/` (l'historique, et la mémoire de chaque projet, pour l'importer), `sessions/` (si la CLI vous attend) et `plans/` ; de `settings.json`, seulement le modèle et la status line. Pour l'onglet Plans, aussi les fichiers `.md` que la conversation a écrits dans le projet ou dans le dossier temporaire de cette session — **seulement ceux que nomme la conversation que vous regardez**, sans parcourir aucun dossier | `.credentials.json` ou tout autre jeton |
| Codex | Dans `~/.codex/` (ou `CODEX_HOME`) : `sessions/` et `archived_sessions/` | `auth.json`, `config.toml` ou ses bases `*.sqlite` |
| OpenCode | Sa base `opencode.db`, ouverte en lecture seule, et, dans celle-ci, seulement les sessions, les messages et leurs parties ; et son catalogue de modèles, pour la taille de la fenêtre de contexte | `auth.json`, `opencode.json`, ou les tables des comptes, des identifiants, des autorisations et des sessions partagées |
| Antigravity CLI | Dans `~/.gemini/antigravity-cli/` : les transcriptions de chaque conversation, `history.jsonl`, la dernière conversation de chaque dossier, le modèle et la status line de `settings.json`, et une **copie** temporaire de son index des conversations ; dans `~/.gemini/config/projects/`, le dossier de chaque projet | Sa configuration MCP, son entrée dans le trousseau du système, le contenu de `conversations/`, et `~/.gemini/antigravity/`, qui est son IDE |
| Pi | Dans `~/.pi/agent/` (ou `PI_CODING_AGENT_DIR`) : les sessions de `sessions/`, et `models-store.json`, son catalogue de modèles, pour la taille de la fenêtre de contexte et le sélecteur de modèle. Dans le paquet Pi installé : son `package.json`, pour connaître la version sans lancer Pi, et sa liste de modèles intégrée | `auth.json`, `models.json`, `settings.json` ou sa configuration MCP |

Les [importateurs de la sauvegarde](#sauvegarde-de-votre-historique), quand
vous les lancez, lisent aussi ce qu'indique leur section. La liste complète,
fichier par fichier, se trouve dans
[`ARCHITECTURE.md`](ARCHITECTURE.md#4-what-is-read-from-each-cli).

<details>
<summary>Les petits caractères : traces, variables d'environnement et ce que l'application écrit</summary>

**Trois traces à connaître :**

- **Lire la base d'OpenCode** fait ce que fait SQLite avec n'importe quel
  lecteur : cela crée ses fichiers `-wal` et `-shm` s'ils manquent et met à
  jour la date de `-shm`. L'application n'exécute jamais de commande OpenCode
  pour la lire.
- **Si le log propre à un onglet Antigravity n'apparaît pas**, l'application
  lit les fichiers `log/cli-*.log` de la CLI, qui contiennent vos messages et
  l'e-mail du compte, uniquement pour trouver l'identifiant de la conversation,
  et sans en garder aucune ligne.
- **Avec OpenCode, l'application lance un serveur OpenCode local**
  (`opencode serve`) : un seul, depuis l'ouverture du premier onglet OpenCode
  jusqu'à cinq minutes après la fermeture du dernier, ou jusqu'à ce que vous
  fermiez l'application. Il écoute sur `127.0.0.1`, sur un port aléatoire, avec
  un mot de passe différent à chaque démarrage, même si votre configuration
  d'OpenCode dit autre chose. L'application ne lui demande que l'état des
  sessions, les autorisations et les questions en attente, de créer une
  session, de répondre à une question et d'arrêter une session : rien sur
  votre configuration ni sur vos comptes.

**Variables d'environnement.** Les CLI héritent de votre environnement tel
quel, sans aucune variable de connexion ajoutée. Deux exceptions :
l'application **retire** `CLAUDE_CODE_CHILD_SESSION` — qui désactive
l'enregistrement de l'historique — et vous le signale par un bandeau quand elle
le fait ; et elle **ajoute** une variable au serveur OpenCode,
`OPENCODE_SERVER_PASSWORD`, avec ce mot de passe propre à chaque démarrage. Ce
n'est le mot de passe d'aucun compte, et la variable n'atteint aucun onglet :
chaque onglet OpenCode reçoit le mot de passe sur sa ligne de commande
(`attach --password`), où d'autres programmes lancés sous votre utilisateur
peuvent le voir. Il ne sert que pour ce serveur et cesse de fonctionner quand
vous fermez l'application.

**Ce que Pi envoie de son côté.** Au démarrage, Pi consulte pi.dev pour
connaître sa dernière version et son catalogue de modèles, et y signale chaque
installation et chaque mise à jour. Ce signalement se désactive dans Pi, pas
ici : `enableInstallTelemetry: false` dans la configuration de Pi, ou la
variable d'environnement `PI_TELEMETRY=0`.

**Ce que l'application écrit :**

- **Dans son propre dossier de configuration :** les onglets ouverts, le cache
  de l'index, les notes, les sessions archivées, les messages non envoyés, les
  scripts des status lines de Claude Code et d'Antigravity avec ce qu'ils
  enregistrent, les branches à part qu'elle a créées avec une copie de chaque
  note texte qu'elle y a copiée (pour combiner les notes plus tard) et, si vous
  l'activez, la sauvegarde
  (ou dans le dossier de votre choix). Avec l'accès à distance activé, aussi la
  liste des appareils associés : un nom, deux dates et un hash des identifiants
  de chacun — jamais les identifiants eux-mêmes.
- **Dans le dossier temporaire :** les images et les fichiers que vous collez
  ou joignez ; le log de chaque onglet Antigravity, qui contient vos messages,
  lisible par vous seul et supprimé au premier démarrage une fois qu'il a plus
  de 24 heures ; et la transcription d'une conversation que vous poursuivez
  avec une autre CLI, supprimée quand vous fermez cet onglet ou au bout de
  24 heures. Pour vérifier si une branche à part entrerait en conflit, git écrit
  ses objets dans un dossier temporaire au lieu de votre dépôt, et ce dossier
  est supprimé juste après.
- **Dans vos projets, trois choses :** la mémoire partagée, seulement si vous
  confirmez, limitée à `.agents/memory/`, à ce qui se trouve entre ses marqueurs
  dans `AGENTS.md` et `CLAUDE.md`, et à quelques lignes à la fin de
  `.gitignore` ; un fichier que vous modifiez dans l'onglet Fichiers, quand vous
  l'enregistrez, ce qui ne remplace que le contenu d'un fichier qui existe déjà
  (rien n'est créé, renommé ni supprimé, et rien n'est écrit dans le dossier
  d'une CLI) ; et les notes d'une branche à part, qui reviennent au dossier
  principal quand vous retirez ou intégrez la branche. Si une note a changé des
  deux côtés, les deux versions sont combinées comme git fusionne le code, et
  vous n'avez à choisir que là où les deux côtés ont modifié les mêmes lignes.

</details>

![Un fichier de l'arborescence, en aperçu avec coloration syntaxique](assets/captura-archivos.png)

---

## Dépannage

**« La commande “claude” est introuvable dans le PATH », suivi de
« Fonctionne aussi avec : … »** — l'application n'a trouvé aucune des CLI.
Vérifiez avec `where claude` sous Windows (`which claude` ailleurs), et de
même avec `codex`, `opencode`, `agy` ou `pi`. Les CLI sont recherchées au
démarrage : si vous en avez installé une pendant que l'application était
ouverte, redémarrez l'application.

**Pi est installé, mais l'application ne le voit pas.** L'application ne lance
pas `pi` pour le trouver : elle lit la version dans le paquet de Pi, à côté de
la commande. Cela fonctionne quand Pi a été installé avec npm ou avec
l'installateur de pi.dev ; un binaire `pi` autonome n'est pas reconnu. Et si un
autre programme nommé `pi` arrive en premier dans votre `PATH`, l'application
l'ignore et le signale dans sa console.

**Dans un onglet Pi, la zone de saisie indique que la CLI attend une réponse de
votre part.** Pi demande s'il faut faire confiance au dossier du projet.
Répondez-y dans l'onglet **CLI** : l'application ne répond jamais à cette
question à votre place.

**L'historique d'OpenCode n'apparaît pas.** Regardez la ligne `History` au
démarrage de l'application. Si elle indique que cette version de Node n'inclut
pas `node:sqlite`, mettez Node à jour vers la 22.13 ou plus récent. S'il n'y a
pas de telle ligne, l'application n'a pas trouvé la base : elle se trouve dans
`~/.local/share/opencode/opencode.db`, ou là où pointe `OPENCODE_DB` ou
`XDG_DATA_HOME`.

**Un onglet OpenCode ne s'ouvre pas : « Couldn't start the OpenCode server ».**
La raison figure après les deux-points. Si elle n'est pas claire, lancez
`opencode` dans un terminal ordinaire : s'il ne démarre pas non plus, le
problème vient de cette installation d'OpenCode.

**Un onglet OpenCode indique que le serveur s'est arrêté.** **Relancer**, dans
la même barre, démarre un autre serveur et reconnecte l'onglet à la même
session.

**Les limites du forfait de Claude Code n'apparaissent pas.** Si la jauge
propose **Configurer**, suivez [ces étapes](#limites-dutilisation-du-forfait-de-claude-code).
Si elle indique **aucune donnée**, la status line est en place mais ne les a
pas encore publiées : elles arrivent avec la première réponse de chaque
session, et seulement avec un forfait d'abonnement.

**Un onglet Antigravity n'affiche ni son état ni la jauge.** Regardez la ligne
`Status line` au démarrage de l'application, sous la CLI. Si elle indique
qu'elle n'est pas configurée, ou qu'il y en a une autre, suivez
[ces étapes](#état-et-jauge-de-contexte-dantigravity-cli). Si vous l'avez
configurée et que le terminal de la CLI affiche `Statusline Error`, `node`
n'est très probablement pas dans le `PATH` de cette session.

**`node-pty` ne compile pas à l'installation.** C'est le module natif du
terminal. En général, il télécharge un binaire tout prêt ; s'il n'y en a pas
pour votre Node et votre plateforme, il faut le compiler :

- **Windows :** Visual Studio Build Tools avec la charge de travail
  *Développement Desktop en C++*, et Python 3. (`windows-build-tools` de npm
  n'est plus maintenu.)
- **macOS :** `xcode-select --install`.
- **Linux :** `build-essential` et `python3`.

**Le terminal reste vide.** Le moteur de rendu par défaut est canvas, et c'est
voulu : avec WebGL, l'onglet se fige sous Windows 11 + Chrome. Pour essayer
WebGL quand même, ajoutez `?renderer=webgl` à l'adresse.

**Un bandeau indique que `CLAUDE_CODE_CHILD_SESSION` a été retirée.** Vous
avez lancé l'application depuis une session Claude Code. Cette variable
désactive l'enregistrement de l'historique : l'application la retire donc et
vous prévient. Depuis un terminal ordinaire, vous ne verrez jamais ce message.

**Depuis l'autre ordinateur, `ssh` n'arrive pas à se connecter** (délai
dépassé ou connexion refusée). Le serveur SSH ne tourne pas sur l'ordinateur
où se trouve l'application, ou quelque chose entre les deux le bloque. Sous
Windows, vérifiez que le réseau Wi‑Fi est défini comme *Privé* : la règle de
pare-feu du serveur SSH peut ne pas couvrir les réseaux *Public*. Un VPN
professionnel qui bloque le réseau local coupe aussi la connexion tant qu'il
est actif. Si `ssh` refuse votre utilisateur, avec un compte Microsoft ou
professionnel il faut peut-être le nom de votre dossier utilisateur
(`C:\Users\<name>`) et le mot de passe du compte, pas le code PIN.

**Depuis l'autre ordinateur, la page affiche « Origin not allowed »** (403).
Elle a été ouverte avec le nom ou l'adresse IP de l'ordinateur. Ouvrez
`http://localhost:<port>`, avec un tunnel qui utilise le même port aux deux
bouts.

**Depuis l'autre ordinateur, la page indique que le jeton de session manque**
(401). Ce navigateur n'est pas associé, il a été révoqué, ou l'accès à distance
est désactivé. Associez-le de nouveau depuis la boîte de dialogue ⇄.

**La boîte de dialogue ⇄ indique que le port est occupé.** Un autre programme
— souvent un second Agent Workbench — l'utilise. Fermez-le et redémarrez, ou
choisissez un autre port.

**Le panneau Modifications dit que le dossier n'est pas un dépôt git**, alors
qu'il en est un. Vérifiez que `git` est dans le `PATH`. Si le message est
différent, c'est l'erreur de git elle-même, mot pour mot.

---

## Depuis le code source

Pour travailler sur l'application, ou si vous préférez ne rien installer
globalement :

```bash
corepack enable pnpm
pnpm install
pnpm dev       # avec rechargement à chaud
```

```bash
pnpm build     # compile l'interface une fois
pnpm start     # sert l'interface compilée
```

**Démarrage en un clic sous Windows :** `pnpm package` compile l'interface et
laisse un **`Agent Workbench.cmd`** à la racine. Double-cliquez dessus : il
installe ce qui manque, compile si nécessaire et ouvre le navigateur. C'est un
fichier texte d'une vingtaine de lignes, que vous pouvez lire avant de
l'exécuter.

---

## Comment c'est construit

Un monorepo pnpm, en TypeScript de bout en bout.

```
packages/
  server/    Node, Express, ws, node-pty, chokidar — serves the interface and runs the terminals
    src/agents/   one adapter per CLI: the only part of the server that knows each one
  web/       Vite, React, xterm.js, highlight.js
  shared/    the protocol types, with no `any` at the edges
android/     the Android app, in Kotlin: the SSH tunnel, the interface, the notifications
```

Deux décisions façonnent le reste. **Les terminaux vivent sur le serveur, et le
navigateur n'est qu'une fenêtre sur eux** : fermer ou recharger la page ne tue
pas une session en cours. Et **le serveur générique ne nomme aucune CLI** : ce
qu'il sait de chacune — où elle range ses données, comment elle se lance, ce
qui est lu et ce qui n'est jamais ouvert — vit dans l'adaptateur de cette CLI,
et l'interface affiche chaque contrôle selon ce que cette CLI déclare.

[`ARCHITECTURE.md`](ARCHITECTURE.md) contient les règles strictes et la carte
du code, [`CONTRIBUTING.md`](CONTRIBUTING.md) comment travailler sur le dépôt,
[`SECURITY.md`](SECURITY.md) comment signaler une vulnérabilité,
[`PRIVACY.md`](PRIVACY.md) ce qui est collecté (rien), et
[`CHANGELOG.md`](CHANGELOG.md) ce qui a changé à chaque version (tous en
anglais). Les commentaires du code sont en espagnol. Les captures d'écran de ce
README viennent de `pnpm demo:shots`, sur des données inventées.

---

## Soutenir le projet

Si Agent Workbench vous est utile, pensez à le soutenir :
[Buy Me a Coffee](https://buymeacoffee.com/cvelasquez). L'application le
propose une fois par version, dans un bandeau que vous pouvez fermer, et plus
jamais avant la suivante.

---

## Licence

MIT. Voir [`LICENSE`](LICENSE).

Agent Workbench est un projet indépendant. Il fonctionne avec les CLI de
Claude Code, Codex, OpenCode, Antigravity et Pi, mais il n'est affilié ni à
Anthropic, ni à OpenAI, ni aux auteurs d'OpenCode, ni à Google, ni à Earendil,
et n'est approuvé par aucun d'entre eux.
