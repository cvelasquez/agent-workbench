# Agent Workbench

[![npm](https://img.shields.io/npm/v/agent-workbench)](https://www.npmjs.com/package/agent-workbench)
[![CI](https://github.com/cvelasquez/agent-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/cvelasquez/agent-workbench/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/agent-workbench)](LICENSE)
[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge.svg)](https://github.com/hesreallyhim/awesome-claude-code)

[English](README.md) · [Español](README.es.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **Português (Brasil)** · [Русский](README.ru.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

**Uma bancada de trabalho visual para os agentes de código que você já usa: as
CLIs do Claude Code, Codex, OpenCode, Antigravity e Pi.** Roda no seu computador
e abre no seu navegador. Usa as CLIs que você já tem instaladas e com login feito,
nunca toca nas suas credenciais e não faz nenhuma chamada de rede por conta
própria.

```bash
npx agent-workbench
```

![Um tour: a conversa como cartões, os arquivos alterados e um diff, uma aba por CLI, e uma conversa continuada com outra CLI](assets/demo.webp)

## Como funciona

O Agent Workbench não fala com nenhum serviço de IA. Ele inicia a CLI que você já
tem — `claude`, `codex`, `opencode`, `agy` ou `pi` — dentro de um terminal de
verdade, e adiciona em volta dela o que um terminal sozinho não oferece: abas, as
suas conversas anteriores, a conversa como cartões fáceis de ler, um medidor de
contexto, os arquivos que mudaram e uma árvore de arquivos.

O terminal continua sendo o terminal: tudo o que você digita vai direto para a
CLI.

---

## O que você ganha

| | |
|---|---|
| **Abas** | Vários agentes ao mesmo tempo, de qualquer CLI, cada um na sua pasta. Um ponto em cada aba mostra se o agente está trabalhando, ocioso ou esperando por você. Recarregar a página não interrompe nada: as CLIs rodam no servidor, não no navegador. |
| **Início rápido** | Ao abrir o app, as suas abas voltam **suspensas**: dá para lê-las por inteiro, e nenhuma CLI é iniciada até você clicar em **Abrir CLI**. |
| **Histórico** | Os seus projetos e conversas anteriores na barra lateral, de todas as CLIs, com um filtro. Clique em uma para retomá-la de onde você parou, com a CLI dela. Arquive sessões antigas ou um projeto inteiro para organizar: nada é excluído, e dá para desfazer. |
| **Conversa** | As mensagens como cartões, ao vivo, com as chamadas de ferramentas recolhidas. As mensagens mais antigas carregam conforme você rola para cima. Busque, copie qualquer mensagem ou bloco de código, e vá para a sua mensagem anterior (↑) ou para o final (↓). Uma linha embaixo mostra quando a sua mensagem chegou à CLI e se o agente ainda está trabalhando. Dependendo da CLI, você pode responder às perguntas do agente ali mesmo. Um arquivo do projeto que o agente menciona abre na aba Arquivos com um clique, e uma pasta, no explorador de arquivos do sistema. Com o Claude Code, uma mensagem que você interrompe antes de o agente começar volta para a caixa para você corrigir, e **↩** em uma mensagem volta para antes dela: a conversa e, se você quiser, o código. Uma mensagem enviada com o agente trabalhando espera no final, marcada na fila; dependendo da CLI, **Forçar envio agora** faz o agente lê-la na hora, e **Editar** (ou ↑ com a caixa vazia) a traz de volta para a caixa para você corrigir. |
| **Caixa de mensagem** | Espaço para escrever, colar imagens e anexar arquivos; um texto longo colado vira um chip compacto. O que você está digitando não se perde ao fechar o app e aparece ao vivo em todas as janelas abertas. Shift+Enter continua uma lista numerada ou com marcadores. O relógio envia sozinho o que você escreveu, no dia e na hora que você escolher, na mesma conversa; ative em Configurações (o Antigravity CLI precisa da status line dele). |
| **Medidor de contexto** | Quanto da janela de contexto do modelo a conversa está usando. Tokens, nunca dinheiro. A partir de 70%, **Compactar** pede à CLI que compacte a conversa. Ao lado dele, com o Claude Code, o Codex e o Antigravity CLI, quanto você já usou dos limites de uso do seu plano e quando eles renovam. |
| **Alterações** | O branch, os arquivos alterados e o diff deles. **Orquestra agentes em paralelo**: abra o projeto em um branch novo, na sua própria pasta, e vários agentes trabalham ao mesmo tempo sem pisar nas alterações uns dos outros. Alterações mostra cada branch: o que falta fazer commit, quantos commits ele tem e se já está integrado. Outra CLI revisa um branch sem mexer nele, e você o integra no main com um clique. |
| **Arquivos** | A árvore de arquivos do projeto, com busca e pré-visualização com realce de sintaxe. Abra vários arquivos ao mesmo tempo, cada um na sua aba; os arquivos Markdown abrem formatados. Um clique coloca o caminho de um arquivo na sua mensagem. Edite um arquivo de texto, um `.env` por exemplo, e salve ali mesmo: se o agente o alterou enquanto você editava, nada é sobrescrito, e você passa suas alterações para a versão nova. |
| **Planos** | Os planos e os documentos `.md` que a conversa escreveu, renderizados. Um clique coloca o caminho de um documento na sua mensagem. |
| **Notas** | Um bloco de anotações ao lado da conversa, com imagens. **Para a caixa** coloca uma nota na caixa de mensagem, para enviá-la à conversa em que você está; com o Claude Code, um clique a envia para uma nova. |
| **Console** | O terminal do seu sistema embaixo, na pasta do projeto: PowerShell, cmd ou Git Bash no Windows; bash ou zsh no macOS e no Linux. |
| **Continuar com…** | Com mais de uma CLI, continue uma conversa com outra na mesma pasta. O novo agente parte de uma transcrição dos últimos turnos. |
| **Notificações** | Um som, e notificações do sistema opcionais, quando um agente termina ou está esperando por você. |
| **Configurações** | ⚙ no cabeçalho: o idioma, o tema do terminal, quais painéis aparecem, qual console abre, quais CLIs o app usa e se dá para agendar mensagens. |
| **Nove idiomas** | English, Español, 简体中文, 日本語, Português (Brasil), Русский, 한국어, Français e Deutsch. Segue o idioma do seu navegador. |
| **Tema** | Claro, escuro ou o do sistema. O terminal fica escuro por padrão, para que as cores das CLIs continuem legíveis. |

Opcionais, e desativados por padrão: [memória compartilhada](#memória-compartilhada-entre-clis)
entre CLIs, um [backup](#backup-do-seu-histórico) do seu histórico, os
[limites de uso do plano](#claude-code-limites-de-uso-do-plano) do Claude Code,
[acesso remoto](#acesso-remoto-via-ssh) de outro computador ou de um celular, e
um [app de Android](#o-app-de-android).

<p>
  <img src="assets/captura-cambios.png" width="49%" alt="O painel Alterações: branch e arquivos alterados, por grupo">
  <img src="assets/captura-diff.png" width="49%" alt="O diff de um desses arquivos, no mesmo painel">
</p>

### Com mais de uma CLI

Cada sessão e cada aba mostra um pequeno selo com a CLI dela, e o `+` de nova aba
deixa você escolher qual abrir. Com uma única CLI, nada disso aparece.

<img src="assets/captura-clis.png" width="45%" alt="A barra lateral de projetos com sessões de várias CLIs, cada uma com o seu selo, e o menu + com as cinco CLIs e as versões delas">

**Nem toda CLI compartilha as mesmas informações**, então alguns recursos
dependem da CLI:

| | Claude Code | Codex | OpenCode | Antigravity CLI | Pi |
|---|:---:|:---:|:---:|:---:|:---:|
| Ponto da aba: trabalhando, ocioso, esperando por você | ✓ | — | ✓ ¹ | ✓ ² | ✓ |
| Responder às perguntas do agente pela conversa | ✓ | — | ✓ ¹ | — | — |
| Medidor de contexto | ✓ | ✓ | ✓ | ✓ ² | ✓ |
| Seletores de modo e de modelo | ✓ | — | — | ✓ | ✓ ³ |
| Colar imagens | ✓ | ✓ | ✓ | — | ✓ ³ |
| Aba Planos | ✓ | — | — | — | — |
| Enviar uma nota para uma nova conversa | ✓ | — | — | — | — |

Para o resto, o terminal da própria CLI está sempre lá: onde há um "—", as
perguntas, por exemplo, são respondidas nele.

¹ Com o OpenCode, o app inicia um servidor local do OpenCode para obter isso
([detalhes](#seus-dados-e-segurança)).
² Só se você configurar a status line da CLI
([como](#antigravity-cli-status-e-medidor-de-contexto)).
³ O Pi não tem modos de permissão: os seletores dele são o modelo e o nível de
raciocínio. E ele não anexa o que você cola: uma imagem vai como um caminho de
arquivo que o próprio modelo abre.

---

## Requisitos

- **Node.js 20 ou mais recente.** Para ver o histórico do OpenCode e os títulos
  das conversas do Antigravity CLI, **22.13 ou mais recente**: eles são lidos com
  o SQLite que vem embutido no Node desde essa versão. Com uma versão anterior,
  todo o resto funciona.
- **git**, para o painel Alterações. Todo o resto funciona sem ele.
- **Pelo menos uma CLI**, instalada e com login feito:

| CLI | Comando | Como instalar |
|---|---|---|
| Claude Code | `claude` | [guia de instalação](https://docs.claude.com/en/docs/claude-code/setup) |
| Codex | `codex` | [guia](https://learn.chatgpt.com/docs/codex/cli) |
| OpenCode | `opencode` | [documentação](https://opencode.ai/docs/) |
| Antigravity CLI | `agy` | [guia](https://antigravity.google/docs/cli/getting-started) |
| Pi | `pi` | [pi.dev](https://pi.dev) |

O Agent Workbench não inclui nem baixa nenhuma CLI: ele encontra as que estão no
seu `PATH`. Se não houver nenhuma, ele avisa e não abre sessões.

**Plataformas.** Desenvolvido e usado todos os dias no Windows 11 com
PowerShell. No macOS e no Linux, cada alteração é instalada e iniciada
automaticamente, mas eles têm menos uso no dia a dia: relatos são bem-vindos. No
Linux, a instalação compila o módulo do terminal, então você precisa de
`python3`, `make` e um compilador C++ (`build-essential` no Debian e no Ubuntu).

---

## Instalar e iniciar

```bash
npm install -g agent-workbench
```

Depois, na pasta do projeto em que você quer trabalhar:

```bash
agent-workbench
```

Ele abre o seu navegador em um endereço como este:

```
  URL          http://127.0.0.1:52341/?token=…
```

Esse endereço é a única forma de entrar: o token muda a cada inicialização, e o
app só escuta no seu próprio computador (`127.0.0.1`).

Para experimentar uma vez sem instalar: `npx agent-workbench`. Na primeira vez,
ele baixa cerca de 60 MB; a maior parte é o módulo nativo do terminal. Para o uso
diário, a instalação global é melhor.

---

## Atalhos de teclado

| Teclas | Ação |
|---|---|
| `Alt+T` | Nova aba |
| `Alt+W` | Fechar a aba |
| `Alt+←` / `Alt+→` (ou `Alt+PgUp` / `Alt+PgDn`) | Aba anterior / próxima |
| `Alt+P` | Mostrar ou ocultar o painel direito |
| `Shift+Tab`, fora do terminal | Voltar para a aba anterior |

O botão `?` no cabeçalho lista todos eles, junto com os atalhos da própria CLI
ativa. Eles usam `Alt` porque o navegador reserva `Ctrl+T`, `Ctrl+W` e
`Ctrl+Tab` para as próprias abas e nunca os repassa para a página.

Todas as outras teclas — `Esc`, `Ctrl+C`, `Ctrl+R`, `Ctrl+O`, as setas, `Alt+V`
para colar imagens — chegam à CLI intactas. `Ctrl+V` também: o que ele faz ali
depende da CLI. Só no console embaixo, no Windows, `Ctrl+V` cola texto, como no
Windows Terminal.

---

## Extras opcionais

### Memória compartilhada entre CLIs

Cada CLI guarda o que aprende sobre um projeto no seu próprio canto, e as outras
não conseguem ver. A aba **Memória** configura uma única memória para todas elas:
notas na pasta `.agents/memory/` do projeto, que todas as CLIs leem e escrevem —
daqui ou do próprio terminal — por meio de `AGENTS.md` e `CLAUDE.md`. A aba
começa oculta: mostre-a em ⚙ Configurações.

**Visualizar alterações** mostra, arquivo por arquivo, o que seria gravado, e
nada é alterado até você confirmar. Ao configurar, a memória que o Claude Code
já tinha para esse projeto é importada. O app não edita as configurações globais
de cada CLI: ele mostra o trecho para você mesmo colar.

<img src="assets/captura-memoria.png" width="70%" alt="A aba Memória com a ponte instalada para as cinco CLIs e as notas importadas">

### Backup do seu histórico

Cada CLI é dona do próprio histórico e pode mudar o formato dele, apagar parte
dele ou ser desinstalada. O backup guarda uma cópia das suas conversas —
mensagens, chamadas e resultados de ferramentas, imagens e a memória de cada
projeto — em uma pasta sua, em arquivos que você pode ler sem o app.

**Vem desativado por padrão.** Abra-o com o botão do backup no topo da barra
lateral de projetos, ou em ⚙ Configurações. **Medir** diz quanto espaço ele
ocuparia por CLI, sem gravar nada, e **Ativar** o inicia. A partir daí, ele copia
tudo o que está na barra lateral e não está arquivado, e copia uma conversa de
novo um minuto depois que ela para de mudar. Ele nunca exclui nada dessa pasta.

Com o backup ativado:

- As conversas que uma CLI não tem mais continuam na barra lateral, marcadas
  como backup, e abrem em Markdown.
- Qualquer projeto pode ser exportado para Markdown.
- Com mais de uma CLI, o filtro da barra lateral pode buscar **Nas conversas**:
  o texto de tudo o que foi copiado, de todas as CLIs.

<img src="assets/captura-buscador.png" width="40%" alt="Busca nas conversas: uma ocorrência em uma sessão de cada CLI, com o trecho dela">

Por padrão, ele fica na pasta de configuração do app
(`%APPDATA%\agent-workbench\vault` no Windows). **Alterar pasta…** o copia para
outra — uma pasta sincronizada, outro disco — sem sobrescrever nada, e deixa a
antiga como estava. Se você colocá-lo em uma pasta sincronizada ou em um
repositório, as suas conversas vão junto.

<details>
<summary>Importar o histórico do Gemini CLI e do Antigravity IDE</summary>

Dois importadores de uso único trazem o histórico de ferramentas que o app não
lê. Eles rodam a partir do código-fonte ([abaixo](#a-partir-do-código-fonte)) e
**não gravam nada sem `--write`**: sem essa opção, só dizem o que importariam.

- `pnpm vault:import gemini-cli [--cwd <folder>]` — os chats que sobraram do
  Gemini CLI. `--cwd` é a pasta onde você o usava, para que eles fiquem nesse
  projeto.
- `pnpm vault:import antigravity-ide --workspace <folder>` — o que dá para ler
  das conversas do Antigravity IDE nessa pasta: o resumo de cada uma e os
  documentos `.md` dela. A conversa em si é criptografada, então ela fica
  marcada como histórico parcial.

</details>

### Claude Code: limites de uso do plano

O Claude Code só informa quanto você já usou dos limites de uso do seu plano (a
janela de 5 horas e a semana) pela *status line* dele. Para vê-los ao lado do
medidor de contexto:

1. Abra uma aba do Claude Code e clique em **Configurar**, ao lado do medidor.
2. Copie a linha que aparece e adicione-a ao que `~/.claude/settings.json` já
   tem. O app não edita esse arquivo: quem edita é você. Ou, com **Copiar
   pedido para o seu agente**, peça a um agente de IA que a adicione por você.
3. Em alguns segundos, ou com **Verificar**, o diálogo mostra **Configurada**.
   Os limites aparecem com a próxima resposta.

O Claude Code aceita uma só status line, então esta substitui qualquer outra que
você tenha, e com ela a CLI deixa de mostrar algumas dicas no rodapé, como "esc
to interrupt". A linha executa um pequeno script guardado na pasta do próprio
app: ele salva só os dois limites e o id da sessão, e os imprime numa linha
curta no rodapé da CLI. Ela roda em **toda** sessão do `claude`, inclusive nas
que você abre fora do app, e precisa do `node` no `PATH`. O Claude Code só
publica esses limites com um plano de assinatura, não com uma chave de API.

O Codex não precisa de nada: ele grava os limites no próprio histórico. O
Antigravity CLI os mostra com a status line dele, descrita abaixo. O OpenCode e
o Pi não os publicam.

### Antigravity CLI: status e medidor de contexto

O Antigravity CLI só informa se está trabalhando ou esperando por você, quantos
tokens já usou e quanto resta da sua cota, pela *status line* dele. Sem ela, as
abas dele funcionam normalmente, mas o ponto da aba diz que o status é
desconhecido e os medidores ficam vazios. Para ativá-la:

1. Abra uma aba do Antigravity e clique em **Configurar**, ao lado do medidor.
2. Copie a linha que aparece e adicione-a ao que
   `~/.gemini/antigravity-cli/settings.json` já tem. O app não edita esse
   arquivo: quem edita é você. Ou, com **Copiar pedido para o seu agente**,
   peça a um agente de IA que a adicione por você.
3. Em alguns segundos, ou com **Verificar**, o diálogo mostra **Configurada**.

A linha executa um pequeno script guardado na pasta do próprio app. Ele salva só
o status, o modo, o modelo e os tokens de cada conversa, e da sua cota só quanto
resta e quando ela renova. Ele não salva o seu e-mail, o seu plano nem o custo,
que a CLI também passa para ele, e não imprime nada, então a status line da
própria CLI continua como estava. Uma vez configurada, ela roda em **toda**
sessão do `agy`, inclusive nas que você abre fora do app, e precisa do `node` no
`PATH`.

### Acesso remoto via SSH

Deixe o Agent Workbench rodando em um computador e use-o a partir de outro da sua
rede, no navegador dele, sem nenhuma CLI instalada lá. **O app nunca é aberto
para a rede**: ele continua escutando só em `127.0.0.1`, e o outro computador
chega até ele por um túnel SSH. O túnel também é o que faz tudo funcionar: por
ele, o outro navegador vê o app como `localhost`, e os navegadores exigem isso
para a área de transferência e as notificações. **Vem desativado por padrão.**

**1. No computador que roda o app, uma vez: ative o servidor SSH dele.** É uma
alteração no sistema que exige permissões de administrador, por isso o app não
faz isso por você.

- **Windows 10/11** — no PowerShell *como administrador*. A primeira linha baixa
  e instala o servidor e leva alguns minutos: espere o prompt voltar.

  ```powershell
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
  Start-Service sshd
  Set-Service -Name sshd -StartupType Automatic
  ```

- **macOS** — Ajustes do Sistema → Geral → Compartilhamento → **Início de Sessão Remoto**.
- **Linux** — instale e ative o servidor OpenSSH da sua distribuição. No Debian
  ou no Ubuntu:

  ```bash
  sudo apt install openssh-server
  sudo systemctl enable --now ssh
  ```

**2. No app: ⇄ no cabeçalho → Ativar o acesso remoto, e depois reinicie o
Agent Workbench.** O túnel precisa de uma porta que não muda, então o app usa
uma fixa (24837 por padrão; dá para mudar), e a porta é escolhida na
inicialização. Reiniciar fecha as CLIs abertas; as suas abas voltam suspensas.
*Desativar* vale na hora.

**3. No outro computador, toda vez: abra o túnel.** O diálogo mostra o comando
pronto para copiar:

```
ssh -N -L 24837:127.0.0.1:24837 you@your-computer
```

Deixe-o rodando, e **use a mesma porta nas duas pontas**: com uma porta local
diferente, o app responde 403. Adicionar
`-o ServerAliveInterval=30 -o ExitOnForwardFailure=yes` faz o túnel perceber uma
queda do Wi‑Fi em vez de travar. No Windows, você pode salvar o comando em um
arquivo `.cmd` e abri-lo com dois cliques.

**4. Pareie esse computador, uma vez.** No diálogo, **Parear um dispositivo** dá
um endereço com um código de uso único, como
`http://localhost:24837/?pair=K7QM-X2RD`. Abra-o no navegador do outro
computador em até cinco minutos. A partir daí, nesse navegador basta abrir
`http://localhost:24837`, mesmo depois que o app reiniciar. O diálogo lista os
dispositivos pareados, e **Revogar** corta o acesso de um deles na hora.

Um dispositivo pareado pode usar o app inteiro, exceto gerenciar o acesso remoto
e as poucas coisas que abririam uma janela no computador que roda o app, como
*Abrir com o app padrão*. Um selo **Remoto** no cabeçalho indica isso. Lembre-se
de que o app inclui um console e inicia agentes, então um dispositivo pareado
pode executar comandos no seu computador, assim como você. **Pareie só
dispositivos que são seus.**

**Em um celular ou tablet.** Pelo mesmo túnel, o navegador de um celular recebe
um layout de uma coluna: a barra lateral de projetos entra deslizando de lado, as
abas ficam no cabeçalho, e uma faixa alterna entre a conversa, a CLI, as
alterações, os arquivos e o resto. Esse layout aparece em qualquer janela com
menos de 768 px de largura. Em uma tela sensível ao toque, Enter na caixa de
mensagem começa uma nova linha (quem envia é o botão de enviar), e arrastar o
dedo sobre um terminal faz a rolagem dele.

<details>
<summary>Uma chave SSH mais segura, que só serve para o túnel (recomendado)</summary>

O login SSH é o do seu usuário naquele computador, então uma senha ou chave que
abre o túnel também abre um terminal completo lá. Você pode criar uma chave que
só serve para o túnel: gere uma no outro computador (`ssh-keygen -t ed25519`) e
adicione a parte pública dela ao `authorized_keys` do computador que roda o app,
com estas opções na frente:

```
restrict,port-forwarding,permitopen="127.0.0.1:24837",command="exit" ssh-ed25519 AAAA… other-computer
```

`restrict` sozinho ainda deixa a chave executar comandos; `command="exit"` é o
que fecha essa porta, e o túnel nunca pede um comando. No Windows, se o seu
usuário é administrador, esse arquivo é
`C:\ProgramData\ssh\administrators_authorized_keys`, e só Administradores e
SYSTEM podem ter permissão de escrita nele; caso contrário, é
`%USERPROFILE%\.ssh\authorized_keys`. Para conferir, tente
`ssh you@your-computer whoami` com essa chave: não deve imprimir nada e deve
terminar na hora, enquanto o túnel `-N -L` continua funcionando.

</details>

### O app de Android

Um app para Android 10 ou mais recente abre o túnel por você e mostra a mesma
interface, servida pelo seu computador, no layout de celular. Ele fica conectado
em segundo plano e avisa quando um agente termina ou está esperando por você,
mesmo com a tela desligada; tocar em uma notificação abre aquela aba. Quando o
Wi‑Fi volta, ele se reconecta sozinho.

Ele precisa do acesso remoto ativado e do servidor SSH do computador rodando
(passos 1 e 2 acima). Baixe-o no
[Google Play](https://play.google.com/store/apps/details?id=io.github.cvelasquez.agentworkbench),
ou compile-o você mesmo a partir de [`android/`](android/), como explica o
[`CONTRIBUTING.md`](CONTRIBUTING.md#the-android-app).

**Pareamento, uma vez:**

1. No diálogo ⇄, escolha **Parear um celular**. Ele mostra uma linha para colar
   em um terminal deste computador, e um QR code. No Windows, se o seu usuário é
   administrador, a linha vai no PowerShell *como administrador*; o diálogo
   avisa.
2. Cole a linha. Ela autoriza a chave do celular só para o túnel: com ela, o
   celular chega ao app e a nada mais — nada de terminal nem de comandos.
3. No app, toque em **Ler código** e aponte a câmera para o QR code. O código
   funciona uma única vez e por cinco minutos, e o diálogo precisa ficar aberto
   até o celular se conectar.

O QR code leva a chave SSH privada do celular. O seu computador a guarda só na
memória até o celular usá-la e nunca a grava no disco: **não compartilhe uma
foto desse QR code**. O celular memoriza a impressão digital SSH do seu
computador na primeira conexão e, se ela mudar algum dia, ele se recusa a
conectar e avisa você.

**Compartilhe uma captura com o seu agente.** Em qualquer app,
**Compartilhar → Agent Workbench** salva imagens (PNG, JPEG, GIF ou WebP) e
texto em uma nota do seu computador, nova ou uma que você escolher, com um
comentário se quiser. Depois, **Para a caixa** na nota a coloca na conversa que
você escolher. O celular não guarda nenhuma cópia.

**Se o endereço IP do seu computador mudar**, **Configurações → Mudar endereço**
aceita o novo, sem parear de novo. O app só o salva se o seu computador
responder ali, com a impressão digital dele.

**Para remover um celular**, use **Revogar** no diálogo e apague a linha dele do
`authorized_keys` (ela termina em `agent-workbench-phone`). No celular,
**Configurações → Esquecer este computador** apaga a chave e a credencial que
ele guarda.

Se as notificações chegarem atrasadas com o celular parado, deixe o app
funcionar sem restrições de bateria:
**Configurações → Abrir as configurações de bateria do app**. O que o app guarda
no celular e as permissões que ele pede estão em [`PRIVACY.md`](PRIVACY.md).

---

## Seus dados e segurança

- **O Agent Workbench não envia nada para lugar nenhum.** Sem telemetria, sem
  analytics, sem chamadas de rede por conta própria. O app de Android só fala
  com o seu computador.
- **Cada CLI continua fazendo por conta própria o que faria se você a abrisse
  manualmente:** ela fala com o provedor de IA dela, e pode verificar se há
  atualizações ou enviar os próprios dados de uso. O Agent Workbench não
  acrescenta nada a isso, e também não desativa isso: ele não altera as
  configurações de nenhuma CLI. O que cada CLI envia está na documentação dela.
- **Nunca toca nas suas credenciais.** Não há tela de login: se uma CLI pedir
  para você fazer login, você faz no próprio terminal dela, e o app nem fica
  sabendo.
- **Lê o histórico das CLIs e não grava nada nas pastas delas.** A tabela abaixo
  lista o que ele lê e o que nunca abre.
- **Só grava nas próprias pastas**, mais três coisas nos seus projetos: a
  memória compartilhada, só se você confirmar; um arquivo que você mesmo edita
  e salva na aba Arquivos; e os branches separados que você abre, cada um na
  sua pasta ao lado do projeto, com as notas que voltam para a pasta principal
  quando você o remove ou integra.
- **O servidor só escuta no seu computador** (`127.0.0.1`), em uma porta
  aleatória, com um token aleatório novo a cada inicialização, e rejeita
  requisições vindas de outras páginas da web. O acesso remoto não muda isso: a
  porta passa a ser fixa, ainda em `127.0.0.1`, e o SSH — que você ativa e
  controla — faz o resto.
- **Git: o app nunca faz commit nem push, nem reescreve o histórico.** Ele roda
  quatro comandos git que gravam, cada um depois de uma confirmação que o
  mostra: `git worktree add` para abrir um branch na sua própria pasta,
  `git worktree remove` (nunca com `--force`), `git branch -d` (só para um
  branch que o app criou e que já está integrado) e `git merge --ff-only` para
  integrar um branch no main sem criar nenhum commit. Ao remover um branch, o
  app apaga arquivos por conta própria só em dois casos: os arquivos novos que
  o diálogo listou, se você escolher perdê-los, e o que o git deixa da pasta do
  branch quando não consegue terminar de apagá-la. Os commits, quem faz são os
  agentes, no terminal deles.

| CLI | O que ele lê | O que ele nunca abre |
|---|---|---|
| Claude Code | De `~/.claude/`: `projects/` (o histórico, e a memória de cada projeto, para importá-la), `sessions/` (se a CLI está esperando por você) e `plans/`; do `settings.json`, só o modelo e a status line. Para a aba Planos, também os arquivos `.md` que a conversa escreveu no projeto ou na pasta temporária dessa sessão — **só os que a conversa que você está vendo menciona**, sem percorrer nenhuma pasta | `.credentials.json` ou qualquer token |
| Codex | De `~/.codex/` (ou `CODEX_HOME`): `sessions/` e `archived_sessions/` | `auth.json`, `config.toml` ou os bancos `*.sqlite` dele |
| OpenCode | O banco `opencode.db`, aberto em modo somente leitura, e dele só as sessões, as mensagens e as partes; e o catálogo de modelos da CLI, para o tamanho da janela de contexto | `auth.json`, `opencode.json` ou as tabelas de contas, credenciais, permissões e sessões compartilhadas |
| Antigravity CLI | De `~/.gemini/antigravity-cli/`: as transcrições de cada conversa, `history.jsonl`, a última conversa de cada pasta, o modelo e a status line do `settings.json`, e uma **cópia** temporária do índice de conversas; de `~/.gemini/config/projects/`, a pasta de cada projeto | A configuração de MCP dele, a entrada no chaveiro do sistema, o conteúdo de `conversations/` e `~/.gemini/antigravity/`, que é o IDE dele |
| Pi | De `~/.pi/agent/` (ou `PI_CODING_AGENT_DIR`): as sessões em `sessions/`, e `models-store.json`, o catálogo de modelos dele, para o tamanho da janela de contexto e o seletor de modelo. Do pacote instalado do Pi: o `package.json` dele, para saber a versão sem executar o Pi, e a lista de modelos que vem embutida nele | `auth.json`, `models.json`, `settings.json` ou a configuração de MCP dele |

Os [importadores do backup](#backup-do-seu-histórico), quando você os executa,
também leem o que a seção deles diz. A lista completa, arquivo por arquivo, está
no [`ARCHITECTURE.md`](ARCHITECTURE.md#4-what-is-read-from-each-cli).

<details>
<summary>As letras miúdas: rastros, variáveis de ambiente e o que o app grava</summary>

**Três rastros que vale a pena conhecer:**

- **Ler o banco do OpenCode** faz o que o SQLite faz com qualquer leitor: cria os
  arquivos `-wal` e `-shm` dele se não existirem e atualiza a data do `-shm`. O
  app nunca executa um comando do OpenCode para lê-lo.
- **Se o log próprio de uma aba do Antigravity não aparecer**, o app lê os
  arquivos `log/cli-*.log` da CLI, que contêm as suas mensagens e o e-mail da
  conta, só para encontrar o id da conversa, e sem guardar nenhuma linha.
- **Com o OpenCode, o app roda um servidor local do OpenCode**
  (`opencode serve`): um só, desde que você abre a primeira aba do OpenCode até
  cinco minutos depois de fechar a última, ou até você fechar o app. Ele escuta
  em `127.0.0.1`, em uma porta aleatória, com uma senha diferente a cada
  inicialização, mesmo que a sua configuração do OpenCode diga outra coisa. O
  app só pede a ele o status das sessões, as permissões e as perguntas
  pendentes, que crie uma sessão, que responda a uma pergunta e que pare uma
  sessão: nada sobre a sua configuração nem sobre as suas contas.

**Variáveis de ambiente.** As CLIs herdam o seu ambiente como está, sem nenhuma
variável de login adicionada. Duas exceções: o app **remove**
`CLAUDE_CODE_CHILD_SESSION` — que desativa o salvamento do histórico — e mostra
um aviso quando faz isso; e **adiciona** uma variável ao servidor do OpenCode,
`OPENCODE_SERVER_PASSWORD`, com aquela senha de cada inicialização. Ela não é a
senha de nenhuma conta, e não chega a nenhuma aba: cada aba do OpenCode a recebe
na linha de comando (`attach --password`), onde outros programas rodando com o
seu usuário podem vê-la. Ela só serve para aquele servidor e deixa de funcionar
quando você fecha o app.

**O que o Pi envia por conta própria.** Ao iniciar, o Pi consulta o pi.dev para
saber a versão mais recente e o catálogo de modelos dele, e informa lá cada
instalação e cada atualização. Você desativa esse envio no Pi, não aqui:
`enableInstallTelemetry: false` nas configurações do Pi, ou a variável de
ambiente `PI_TELEMETRY=0`.

**O que o app grava:**

- **Na própria pasta de configuração:** as abas abertas, o cache do índice, as
  notas, as sessões arquivadas, as mensagens não enviadas e as agendadas (e, enquanto roda, um arquivo com o número do processo, para que duas cópias abertas não enviem uma duas vezes), os scripts da status
  line do Claude Code e do Antigravity com o que eles salvam, os branches
  separados que o app criou com uma cópia de cada nota de texto copiada para
  eles (para juntar as notas depois) e, se você o ativar, o backup (ou na pasta
  que você escolher). Com o acesso remoto ativado, também a lista de dispositivos
  pareados: um nome, duas datas e um hash da credencial de cada um — nunca a
  credencial em si.
- **Na pasta temporária:** as imagens e os arquivos que você cola ou anexa; o
  log de cada aba do Antigravity, que contém as suas mensagens, só pode ser lido
  por você e é apagado na primeira inicialização depois de completar 24 horas; e
  a transcrição de uma conversa que você continua com outra CLI, apagada quando
  você fecha essa aba ou depois de 24 horas. Para verificar se um branch
  separado entraria em conflito, o git grava os objetos que cria em uma pasta
  temporária em vez de no seu repositório, e a pasta é apagada logo em seguida.
- **Nos seus projetos, três coisas:** a memória compartilhada, só se você
  confirmar, limitada a `.agents/memory/`, ao que está entre os marcadores dela
  em `AGENTS.md` e `CLAUDE.md`, e a algumas linhas no final do `.gitignore`; um
  arquivo que você edita na aba Arquivos, quando o salva, o que só substitui o
  conteúdo de um arquivo que já existe (nada é criado, renomeado nem excluído, e
  nada é gravado dentro da pasta de uma CLI); e as notas de um branch separado,
  que voltam para a pasta principal quando você remove ou integra o branch. Se
  uma nota mudou dos dois lados, as duas versões são juntadas como o git junta o
  código, e você só escolhe onde os dois lados mudaram as mesmas linhas.

</details>

![Um arquivo da árvore, pré-visualizado com realce de sintaxe](assets/captura-archivos.png)

---

## Solução de problemas

**"O comando "claude" não foi encontrado no PATH", seguido de "Também funciona
com: …"** — o app não encontrou nenhuma das CLIs. Confira com
`where claude` no Windows (`which claude` nos outros sistemas), e o mesmo com
`codex`, `opencode`, `agy` ou `pi`. As CLIs são procuradas na inicialização: se
você instalou uma com o app aberto, reinicie-o.

**O Pi está instalado, mas o app não o vê.** O app não executa o `pi` para
encontrá-lo: ele lê a versão no pacote do Pi, ao lado do comando. Isso funciona
quando o Pi foi instalado com o npm ou com o instalador do pi.dev; um binário
`pi` avulso não é reconhecido. E, se outro programa chamado `pi` vier antes no
seu `PATH`, o app o ignora e avisa isso no próprio console.

**Em uma aba do Pi, a caixa de mensagem diz que a CLI está aguardando uma
resposta sua.** O Pi está perguntando se deve confiar na pasta do projeto.
Responda na aba **CLI**: o app nunca responde a isso por você.

**O histórico do OpenCode não aparece.** Olhe a linha `History` quando o app
inicia. Se ela diz que essa versão do Node não inclui `node:sqlite`, atualize o
Node para a 22.13 ou mais recente. Se essa linha não aparece, ele não encontrou
o banco: ele fica em `~/.local/share/opencode/opencode.db`, ou onde
`OPENCODE_DB` ou `XDG_DATA_HOME` apontar.

**Uma aba do OpenCode não abre: "Couldn't start the OpenCode server".** O motivo
vem depois dos dois-pontos. Se ele não for claro, abra o `opencode` em um
terminal comum: se ele também não iniciar lá, o problema é essa instalação do
OpenCode.

**Uma aba do OpenCode diz que o servidor foi encerrado.** **Reiniciar**, na
mesma barra, inicia outro servidor e reconecta a aba à mesma sessão.

**Os limites do plano do Claude Code não aparecem.** Se o medidor oferece
**Configurar**, siga [estes passos](#claude-code-limites-de-uso-do-plano). Se ele
diz **sem dados**, a status line está configurada, mas ainda não os publicou:
eles chegam com a primeira resposta de cada sessão, e só com um plano de
assinatura.

**Uma aba do Antigravity não mostra o status nem o medidor.** Olhe a entrada
`Status line` quando o app inicia, abaixo da CLI. Se ela diz que não está
configurada, ou que há outra, siga
[estes passos](#antigravity-cli-status-e-medidor-de-contexto). Se você a
configurou e o terminal da CLI mostra `Statusline Error`, o mais provável é que
o `node` não esteja no `PATH` dessa sessão.

**O `node-pty` não compila na instalação.** É o módulo nativo do terminal.
Normalmente ele baixa um binário pronto; se não houver um para o seu Node e a sua
plataforma, ele precisa ser compilado:

- **Windows:** Visual Studio Build Tools com a carga de trabalho
  *Desenvolvimento para desktop com C++*, e Python 3. (O `windows-build-tools`
  do npm não é mais mantido.)
- **macOS:** `xcode-select --install`.
- **Linux:** `build-essential` e `python3`.

**O terminal fica em branco.** O renderizador padrão é canvas, de propósito: com
WebGL, a aba trava no Windows 11 + Chrome. Para testar o WebGL mesmo assim,
adicione `?renderer=webgl` ao endereço.

**Um aviso diz que `CLAUDE_CODE_CHILD_SESSION` foi removida.** Você iniciou o
app de dentro de uma sessão do Claude Code. Essa variável desativa o salvamento
do histórico, então o app a remove e avisa você. A partir de um terminal comum,
você nunca vai ver isso.

**Do outro computador, o `ssh` não consegue conectar** (o tempo esgota ou a
conexão é recusada). O servidor SSH não está rodando no computador do app, ou
algo entre os dois o bloqueia. No Windows, confira se a rede Wi‑Fi está como
*Privada*: a regra de firewall do servidor SSH pode não cobrir redes *Públicas*.
Uma VPN do trabalho que bloqueia a rede local também corta a conexão enquanto
está ligada. Se o `ssh` recusar o seu usuário: com uma conta Microsoft ou do
trabalho, talvez seja preciso usar o nome da sua pasta de usuário
(`C:\Users\<name>`) e a senha da conta, não o PIN.

**Do outro computador, a página diz "Origin not allowed"** (403). Ela foi aberta
pelo nome ou pelo endereço IP do computador. Abra `http://localhost:<port>`, com
o túnel usando a mesma porta nas duas pontas.

**Do outro computador, a página diz que falta o token de sessão** (401). Esse
navegador não está pareado, foi revogado, ou o acesso remoto está desativado.
Pareie-o de novo pelo diálogo ⇄.

**O diálogo ⇄ diz que a porta está ocupada.** Outro programa — muitas vezes um
segundo Agent Workbench — está usando a porta. Feche-o e reinicie, ou escolha
outra porta.

**O painel Alterações diz que a pasta não está dentro de um repositório git**, e
ela está. Confira se o `git` está no `PATH`. Se a mensagem for outra, é o
próprio erro do git, palavra por palavra.

---

## A partir do código-fonte

Para trabalhar no app, ou se você prefere não instalar nada globalmente:

```bash
corepack enable pnpm
pnpm install
pnpm dev       # com hot reload
```

```bash
pnpm build     # compila a interface uma vez
pnpm start     # serve a interface compilada
```

**Início com um clique no Windows:** `pnpm package` compila a interface e deixa
um **`Agent Workbench.cmd`** na raiz. Dê dois cliques nele: ele instala o que
estiver faltando, compila se for preciso e abre o navegador. É um arquivo de
texto de vinte linhas que você pode ler antes de executar.

---

## Como é feito

Um monorepo pnpm, TypeScript em tudo.

```
packages/
  server/    Node, Express, ws, node-pty, chokidar — serves the interface and runs the terminals
    src/agents/   one adapter per CLI: the only part of the server that knows each one
  web/       Vite, React, xterm.js, highlight.js
  shared/    the protocol types, with no `any` at the edges
android/     the Android app, in Kotlin: the SSH tunnel, the interface, the notifications
```

Duas decisões definem o resto. **Os terminais vivem no servidor, e o navegador é
só uma janela para eles**: fechar ou recarregar a página não mata uma sessão em
andamento. E **o servidor genérico não nomeia nenhuma CLI**: o que ele sabe sobre
cada uma — onde ela guarda as coisas, como é iniciada, o que é lido e o que nunca
é aberto — vive no adaptador daquela CLI, e a interface mostra cada controle de
acordo com o que aquela CLI declara.

[`ARCHITECTURE.md`](ARCHITECTURE.md) traz as regras rígidas e o mapa do código,
[`CONTRIBUTING.md`](CONTRIBUTING.md), como trabalhar no repositório,
[`SECURITY.md`](SECURITY.md), como relatar uma vulnerabilidade,
[`PRIVACY.md`](PRIVACY.md), o que é coletado (nada), e
[`CHANGELOG.md`](CHANGELOG.md), o que mudou em cada versão (todos em inglês). Os
comentários do código estão em espanhol. As capturas de tela deste README vêm de
`pnpm demo:shots`, com dados fictícios.

---

## Apoie o projeto

Se o Agent Workbench é útil para você, considere apoiá-lo:
[Buy Me a Coffee](https://buymeacoffee.com/cvelasquez). O app sugere isso uma vez
por versão, em uma faixa que você pode fechar, e não volta a sugerir até a
próxima.

---

## Licença

MIT. Veja [`LICENSE`](LICENSE).

O Agent Workbench é um projeto independente. Ele funciona com as CLIs do
Claude Code, Codex, OpenCode, Antigravity e Pi, mas não é afiliado à Anthropic,
à OpenAI, aos autores do OpenCode, ao Google nem à Earendil, nem é endossado por
eles.
