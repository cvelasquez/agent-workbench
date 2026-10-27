/**
 * Chequeo de Ajustes (Hito 41, §6.32).
 *
 *   npx tsx scripts/check-settings.mjs
 *
 * Lo que se rompe sin verse:
 *
 *  - **Un settings.json de antes** (sin consola ni CLIs) tiene que leerse igual,
 *    y un valor que no sirve caer a su defecto sin llevarse lo demas.
 *  - **Que consola abre una nueva.** "Automatico" tiene que dar lo de siempre
 *    —pwsh, powershell, cmd; $SHELL, bash, sh—, Git Bash se busca subiendo desde
 *    git.exe y nunca es el de System32, y una elegida que no esta cae a la
 *    automatica.
 *  - **Una CLI apagada** no se busca —no se corre su --version—, no es la de por
 *    defecto y su historial no se lee.
 *  - **Lo que se esconde**: la solapa CLI no se esconde nunca, ni el chat del
 *    telefono; una escondida que estaba elegida muestra la CLI.
 *  - **Una ventana remota** no cambia los ajustes del servidor.
 *  - **La consola y la barra de proyectos** (22-10-2026): una terminal solo si
 *    se pide, y la barra se esconde al abrir una sesion nueva desde ella.
 *  - **La status line que falta para programar** (27-10-2026): la casilla de los
 *    mensajes programados nombra solo a la CLI instalada que la necesita y no
 *    la tiene, y el pedido para un agente lleva el fragmento tal cual.
 *
 * Sobre una carpeta temporal propia: no toca la configuracion real, no lanza
 * ninguna consola ni ninguna CLI.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseClientMessage, parseServerMessage, encodeServerMessage } from '@agent-workbench/shared';
import { SettingsStore, parseAppSettings, defaultAppSettings } from '../src/settings-store.ts';
import { gitBashCandidates, locateShells, pickShell } from '../src/shell-locator.ts';
import { AgentRegistry } from '../src/agents/registry.ts';
import { AppSettingsChangeError, AppSettingsService } from '../src/app-settings-service.ts';
import { remoteRefusal } from '../src/remote-access.ts';
import { vaultOnlySessions } from '../src/session-index.ts';
import { DEFAULT_HIDDEN_PANELS, HIDEABLE_PANELS, parseHiddenPanels, serializeHiddenPanels, withPanelVisible } from '../../web/src/panel-visibility.ts';
import { effectivePanelTab, scheduledNeedsStatusLine, statusLineAgentPrompt, visiblePanelTabs } from '../../web/src/agent-ui.ts';
import { statusLineFragment } from '../src/agents/antigravity/statusline-script.ts';
import { claudeStatusLineFragment } from '../src/agents/claude-code/statusline-script.ts';
import { narrowViews } from '../../web/src/narrow-layout.ts';
import { shellToOpenOnUnfold } from '../../web/src/console-shells.ts';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};
const json = (value) => JSON.stringify(value);

const workDir = await mkdtemp(path.join(os.tmpdir(), 'aw-check-settings-'));

// --- 1. settings.json ------------------------------------------------------------
{
  const old = parseAppSettings({ version: 1, vault: { enabled: true, dir: null, toolResultMaxChars: 64000 } }, process.platform);
  check('1.1 un settings.json de antes se lee con la consola automatica y ninguna CLI apagada',
    old.console.shell === 'auto' && json(old.agents.disabled) === '[]' && old.vault.enabled === true, json(old));
  const odd = parseAppSettings(
    { version: 1, console: { shell: 'powershell-9000' }, agents: { disabled: ['codex', 'gemini-cli', 7, 'codex'] }, remote: { enabled: true, port: 30000 } },
    process.platform,
  );
  check('1.2 una consola que no se conoce cae a la automatica; una CLI que no se conoce se descarta, sin repetir',
    odd.console.shell === 'auto' && json(odd.agents.disabled) === '["codex"]' && odd.remote.port === 30000, json(odd));
  const good = parseAppSettings({ version: 1, console: { shell: 'git-bash' }, agents: { disabled: ['opencode'] } }, process.platform);
  check('1.3 lo que si sirve se lee', good.console.shell === 'git-bash' && json(good.agents.disabled) === '["opencode"]');
  check('1.4 sin la copia propia en el archivo, igual se leen la consola y las CLIs (no los salta el return temprano)',
    parseAppSettings({ version: 1, console: { shell: 'cmd' } }, process.platform).console.shell === 'cmd');

  const file = path.join(workDir, 'settings.json');
  const store = new SettingsStore(file, { log: { warn: () => undefined } });
  await store.load();
  await store.update({ remote: { enabled: true, port: 30000 } });
  await store.update({ console: { shell: 'pwsh' } });
  await store.update({ agents: { disabled: ['antigravity', 'antigravity'] } });
  const saved = JSON.parse(await readFile(file, 'utf8'));
  check('1.5 cambiar la consola y las CLIs no pierde el acceso remoto, y escribe sin repetir',
    saved.remote.port === 30000 && saved.console.shell === 'pwsh' && json(saved.agents.disabled) === '["antigravity"]', json(saved));
  const reread = new SettingsStore(file, { log: { warn: () => undefined } });
  await reread.load();
  check('1.6 lo escrito se vuelve a leer igual', json(reread.get()) === json(store.get()));
  check('1.7 lo que devuelve get() no se puede cambiar por afuera', (() => {
    try {
      store.get().agents.disabled.push('codex');
      return false;
    } catch {
      return true;
    }
  })());
  check('1.8 los de por defecto', json(defaultAppSettings().console) === '{"shell":"auto"}' && json(defaultAppSettings().agents) === '{"disabled":[]}');

  // Hito 51: los mensajes programados, apagados si no se dice otra cosa.
  check('1.9 un settings.json de antes: los mensajes programados apagados',
    old.scheduledMessages.enabled === false && defaultAppSettings().scheduledMessages.enabled === false);
  check('1.10 encendido se lee; un valor que no es si o no, apagado',
    parseAppSettings({ version: 1, scheduledMessages: { enabled: true } }, process.platform).scheduledMessages.enabled === true &&
      parseAppSettings({ version: 1, scheduledMessages: { enabled: 'si' } }, process.platform).scheduledMessages.enabled === false &&
      parseAppSettings({ version: 1, scheduledMessages: true }, process.platform).scheduledMessages.enabled === false);
  await store.update({ scheduledMessages: { enabled: true } });
  const withScheduled = JSON.parse(await readFile(file, 'utf8'));
  check('1.11 encenderlo se escribe, sin perder lo demas',
    withScheduled.scheduledMessages?.enabled === true && withScheduled.console.shell === 'pwsh' && withScheduled.remote.port === 30000, json(withScheduled));
  // La otra instancia lo apaga: esta lo relee, y otro cambio suyo no lo vuelve a encender.
  const other = new SettingsStore(file, { log: { warn: () => undefined } });
  await other.load();
  await other.update({ scheduledMessages: { enabled: false } });
  check('1.12 releer trae lo que cambio la otra instancia', (await store.reloadScheduledMessages()) === true && store.get().scheduledMessages.enabled === false);
  check('1.13 releer sin cambios dice que no cambio nada', (await store.reloadScheduledMessages()) === false);
  await other.update({ scheduledMessages: { enabled: true } });
  await store.update({ console: { shell: 'cmd' } });
  check('1.14 cambiar la consola no pisa lo que encendio la otra',
    JSON.parse(await readFile(file, 'utf8')).scheduledMessages?.enabled === true && store.get().scheduledMessages.enabled === true);
}

// --- 2. Las consolas instaladas ------------------------------------------------------
{
  const probe = (platform, env, inPath, executables) => ({
    platform,
    env,
    findInPath: async (command) => inPath[command] ?? null,
    isExecutable: async (candidate) => executables.has(candidate),
  });
  const winEnv = { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  const systemPs = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const all = await locateShells(
    probe('win32', winEnv, { pwsh: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', git: 'C:\\Program Files\\Git\\cmd\\git.exe' }, new Set([systemPs, winEnv.ComSpec, gitBash])),
  );
  check('2.1 Windows: las cuatro, en el orden de la automatica',
    json(all.map((shell) => shell.id)) === json(['pwsh', 'powershell', 'cmd', 'git-bash']), json(all.map((shell) => shell.id)));
  check('2.2 las dos PowerShell se distinguen en Ajustes y en su solapa siguen siendo "PowerShell"',
    all[0].label === 'PowerShell 7' && all[1].label === 'Windows PowerShell' && all[0].location.name === 'PowerShell' && all[1].location.name === 'PowerShell');
  check('2.3 Git Bash interactivo y de inicio de sesion', json(all[3].location.args) === json(['--login', '-i']) && all[3].location.file === gitBash);
  check('2.4 automatica: pwsh, como siempre', pickShell(all, 'auto')?.file === all[0].location.file);
  check('2.5 elegida: la elegida', pickShell(all, 'git-bash')?.file === gitBash && pickShell(all, 'cmd')?.file === winEnv.ComSpec);

  const noPwsh = await locateShells(probe('win32', winEnv, {}, new Set([systemPs, winEnv.ComSpec])));
  check('2.6 sin pwsh ni git: powershell de la carpeta del sistema y cmd; elegir pwsh cae a la automatica',
    json(noPwsh.map((shell) => shell.id)) === json(['powershell', 'cmd']) && pickShell(noPwsh, 'pwsh')?.file === systemPs);
  const onlyGit = await locateShells(probe('win32', { ...winEnv, ComSpec: '' }, { git: 'C:\\Program Files\\Git\\cmd\\git.exe' }, new Set([gitBash])));
  check('2.7 con solo Git Bash, la automatica es ninguna: nunca una que no se eligio', pickShell(onlyGit, 'auto') === null && pickShell(onlyGit, 'git-bash')?.file === gitBash);

  const fromUcrt = gitBashCandidates('C:\\Program Files\\Git\\ucrt64\\bin\\git.exe', {});
  check('2.8 subiendo desde ucrt64\\bin\\git.exe se llega a Git\\bin\\bash.exe', fromUcrt.includes(gitBash), json(fromUcrt));
  const fromSystem = gitBashCandidates('C:\\Windows\\System32\\git.exe', { SystemRoot: 'C:\\Windows' });
  check('2.9 nada debajo de la carpeta del sistema: el bash.exe de ahi es WSL', fromSystem.every((candidate) => !candidate.toLowerCase().startsWith('c:\\windows')), json(fromSystem));

  const posix = await locateShells(probe('linux', { SHELL: '/bin/zsh' }, {}, new Set(['/bin/zsh', '/bin/bash', '/bin/sh'])));
  check('2.10 Linux: $SHELL primero (sin repetirlo), y la automatica es esa',
    json(posix.map((shell) => shell.id)) === json(['login', 'bash', 'sh']) && pickShell(posix, 'auto')?.file === '/bin/zsh', json(posix.map((shell) => shell.id)));
  const posixNoShell = await locateShells(probe('darwin', {}, {}, new Set(['/bin/bash', '/bin/sh', '/bin/zsh'])));
  check('2.11 sin $SHELL: bash, como antes; zsh se ofrece pero no es la automatica',
    pickShell(posixNoShell, 'auto')?.file === '/bin/bash' && pickShell(posixNoShell, 'zsh')?.file === '/bin/zsh');
}

// --- 3. Una CLI apagada ------------------------------------------------------------
{
  const located = [];
  const fakeAdapter = (id) => ({
    id,
    label: id,
    locate: async () => {
      located.push(id);
      return { resolvedPath: `/bin/${id}`, file: `/bin/${id}`, prefixArgs: [], version: '1.0' };
    },
  });
  const registry = new AgentRegistry([fakeAdapter('claude-code'), fakeAdapter('codex'), fakeAdapter('opencode')], ['claude-code', 'gemini-cli']);
  await registry.locateAll();
  check('3.1 una apagada no se busca: no se corre su --version', json(located.sort()) === json(['codex', 'opencode']), json(located));
  check('3.2 queda como no instalada, y la de por defecto es la siguiente',
    registry.get('claude-code')?.location === null && registry.defaultAgent() === 'codex');
  check('3.3 su historial no se lee', json(registry.historySources().map((entry) => entry.adapter.id)) === json(['codex', 'opencode']));
  check('3.4 una desconocida en la lista se ignora', json(registry.disabledIds()) === json(['claude-code']));

  // Sus sesiones en la copia propia tampoco vuelven a la barra como "copia".
  const copy = (agent, sessionId) => ({ agent, sessionId, cwd: 'D:\\p', group: 'g', title: 't', titleSource: 'ai', updatedAt: 1, sizeBytes: 1, partial: false });
  const shown = vaultOnlySessions([], [copy('codex', 'c1'), copy('opencode', 'o1'), copy('gemini-cli', 'g1')], new Map([['codex', 'off'], ['opencode', 'missing']]), true);
  check('3.5 una CLI apagada no devuelve sus copias a la barra; las demas y las importadas, si',
    json(shown.map((item) => item.agent).sort()) === json(['gemini-cli', 'opencode']), json(shown.map((item) => item.agent)));
}

// --- 4. El servicio de Ajustes ----------------------------------------------------
{
  const store = new SettingsStore(path.join(workDir, 'service', 'settings.json'), { log: { warn: () => undefined } });
  await store.load();
  const shells = [
    { id: 'pwsh', label: 'PowerShell 7', location: { file: 'pwsh.exe', args: ['-NoLogo'], name: 'PowerShell' } },
    { id: 'git-bash', label: 'Git Bash', location: { file: 'bash.exe', args: ['--login', '-i'], name: 'Git Bash' } },
  ];
  const changes = [];
  const service = new AppSettingsService({ settings: store, agents: { disabledIds: () => ['opencode'] }, shells, onShellChange: (shell) => changes.push(shell?.name ?? null) });
  const emitted = [];
  service.on('status', (status) => emitted.push(status));
  check('4.1 el estado: la automatica, las instaladas y la apagada del arranque',
    json(service.status()) === json({ consoleShell: 'auto', consoleShells: [{ id: 'pwsh', label: 'PowerShell 7' }, { id: 'git-bash', label: 'Git Bash' }], shellName: 'PowerShell', disabledAgents: [], disabledAtStart: ['opencode'], scheduledMessages: false }),
    json(service.status()));
  await service.update({ consoleShell: 'git-bash' });
  check('4.2 elegir Git Bash avisa al registro y a todas las ventanas',
    json(changes) === '["Git Bash"]' && emitted.at(-1)?.shellName === 'Git Bash' && service.currentShell()?.name === 'Git Bash');
  const refused = await service.update({ consoleShell: 'cmd' }).then(() => null, (error) => error);
  check('4.3 una consola que no esta instalada no se acepta', refused instanceof AppSettingsChangeError && store.get().console.shell === 'git-bash');
  await service.update({ disabledAgents: ['codex'] });
  check('4.4 apagar una CLI se guarda, y lo del arranque no cambia hasta reiniciar',
    json(service.status().disabledAgents) === '["codex"]' && json(service.status().disabledAtStart) === '["opencode"]' && changes.length === 1);
  // Hito 51.
  const before = emitted.length;
  await service.update({ scheduledMessages: true });
  check('4.5 encender los mensajes programados se guarda y avisa a todas las ventanas',
    service.scheduledMessagesEnabled() === true && emitted.length === before + 1 && emitted.at(-1)?.scheduledMessages === true && changes.length === 1);
  const otherStore = new SettingsStore(path.join(workDir, 'service', 'settings.json'), { log: { warn: () => undefined } });
  await otherStore.load();
  await otherStore.update({ scheduledMessages: { enabled: false } });
  await service.refreshScheduledMessages();
  check('4.6 apagado desde la otra instancia: se entera al releer y avisa',
    service.scheduledMessagesEnabled() === false && emitted.at(-1)?.scheduledMessages === false);
  const quiet = emitted.length;
  await service.refreshScheduledMessages();
  check('4.7 releer sin cambios no avisa', emitted.length === quiet);
}

// --- 5. El protocolo ----------------------------------------------------------------
{
  check('5.1 settings.update con una consola o con las CLIs',
    json(parseClientMessage(json({ type: 'settings.update', consoleShell: 'git-bash' }))) === json({ type: 'settings.update', consoleShell: 'git-bash' }) &&
      json(parseClientMessage(json({ type: 'settings.update', disabledAgents: ['codex', 'gemini-cli'] }))) === json({ type: 'settings.update', disabledAgents: ['codex'] }));
  check('5.2 un settings.update vacio, con una consola desconocida o con una ruta, no se lee',
    parseClientMessage(json({ type: 'settings.update' })) === null &&
      parseClientMessage(json({ type: 'settings.update', consoleShell: 'C:\\Windows\\System32\\cmd.exe' })) === null &&
      parseClientMessage(json({ type: 'settings.update', disabledAgents: 'codex' })) === null);
  const status = { consoleShell: 'auto', consoleShells: [{ id: 'cmd', label: 'cmd' }, { id: 'nada', label: 'x' }], shellName: null, disabledAgents: [], disabledAtStart: [] };
  const parsed = parseServerMessage(encodeServerMessage({ type: 'settings.status', settings: status }));
  check('5.3 settings.status: una consola desconocida se descarta sola, sin llevarse el resto',
    parsed?.type === 'settings.status' && json(parsed.settings.consoleShells) === '[{"id":"cmd","label":"cmd"}]' && parsed.settings.shellName === null, json(parsed));
  check('5.4 una ventana remota no cambia los ajustes del servidor; una del anfitrion si',
    remoteRefusal('settings.update', true)?.key === 'settingsHostOnly' && remoteRefusal('settings.update', false) === null);
  check('5.5 settings.update con solo los mensajes programados (hito 51)',
    json(parseClientMessage(json({ type: 'settings.update', scheduledMessages: true }))) === json({ type: 'settings.update', scheduledMessages: true }) &&
      parseClientMessage(json({ type: 'settings.update', scheduledMessages: 1 })) === null);
  check('5.6 programar desde un equipo remoto si se atiende: es como mandar un mensaje',
    remoteRefusal('schedule.create', true) === null && remoteRefusal('schedule.cancel', true) === null && remoteRefusal('schedule.sendNow', true) === null);
}

// --- 6. Lo que se esconde -------------------------------------------------------------
{
  const hidden = parseHiddenPanels('notes, console,cli,chat,raro');
  check('6.1 se leen las que se conocen; la CLI y el chat no se pueden esconder',
    json([...hidden].sort()) === json(['console', 'notes']), json([...hidden]));
  check('6.2 ida y vuelta, en el orden de la lista', serializeHiddenPanels(hidden) === 'console,notes' && parseHiddenPanels('').size === 0);
  check('6.2b sin nada guardado, Memoria arranca escondida (la mayoria usa una sola CLI); mostrarla se guarda como "none"',
    json([...DEFAULT_HIDDEN_PANELS]) === json(['memory']) && serializeHiddenPanels(new Set()) === 'none' && parseHiddenPanels('none').size === 0);
  check('6.3 mostrar y esconder', json([...withPanelVisible(withPanelVisible(hidden, 'notes', true), 'git', false)].sort()) === json(['console', 'git']));
  check('6.4 Ajustes lista seis, sin la CLI', HIDEABLE_PANELS.length === 6 && !HIDEABLE_PANELS.includes('cli'));
  const tabs = ['cli', 'git', 'files', 'plans', 'memory'].map((id) => ({ id }));
  const all = new Set(['cli', 'git', 'files', 'plans', 'memory']);
  check('6.5 las solapas: se van las escondidas, la CLI nunca',
    json(visiblePanelTabs(tabs, true, new Set(['git', 'memory'])).map((tab) => tab.id)) === json(['cli', 'files', 'plans']) &&
      json(visiblePanelTabs(tabs, true, all).map((tab) => tab.id)) === json(['cli']));
  check('6.6 una escondida que estaba elegida muestra la CLI; sin esconder, como antes',
    effectivePanelTab('files', true, new Set(['files'])) === 'cli' && effectivePanelTab('files', true) === 'files' && effectivePanelTab('plans', false) === 'cli');
  check('6.7 el telefono: las vistas escondidas no se ofrecen; el chat y la CLI siempre',
    json(narrowViews({ hasTab: true, plansAvailable: true, hidden: new Set(['console', 'notes', 'chat', 'cli']) })) === json(['chat', 'cli', 'git', 'files', 'plans', 'memory']) &&
      json(narrowViews({ hasTab: false, plansAvailable: true, hidden: new Set(['notes']) })) === json(['chat']));
}

// --- 7. La consola: una terminal solo si se pide (22-10-2026) ---------------------------
//
// Hasta el 22-10-2026, con la consola a la vista, toda pestana de un proyecto sin
// terminal abria una: abrir una sesion o pasar a otro proyecto dejaba andando un
// proceso que nadie pidio. Lo que se rompe sin verse: que vuelva a abrirse una
// sola, o que desplegar la consola en un proyecto sin ninguna deje de abrirla.
{
  const A = 'D:\\proyectos\\uno';
  const B = 'D:\\proyectos\\dos';
  const unfold = (cwd, shellCwds, shellAvailable = true) => shellToOpenOnUnfold({ cwd, shellCwds, shellAvailable });
  check('7.1 desplegar la consola en un proyecto sin ninguna abre una, ahi, aunque otro proyecto tenga', unfold(A, []) === A && unfold(A, [B]) === A);
  check('7.2 con una abierta en el proyecto, desplegarla no abre otra', unfold(A, [B, A]) === null);
  check('7.3 sin pestana, o sin consola en el sistema, no se abre nada', unfold(null, []) === null && unfold(A, [], false) === null);

  // La pagina abre una terminal en dos sitios, los dos un clic: el `+` y el
  // enlace del hueco (`openConsoleHere`), y desplegar la consola. Ninguno puede
  // ser un efecto, que corre al cambiar de pestana sin que nadie lo pida.
  const app = await readFile(new URL('../../web/src/App.tsx', import.meta.url), 'utf8');
  const openers = [...app.matchAll(/\bopenShell\(/g)].map(({ index }) => {
    const before = app.slice(0, index);
    if (before.lastIndexOf('useEffect(') > before.lastIndexOf('= useCallback(')) return 'useEffect';
    return [...before.matchAll(/const (\w+) = useCallback\(/g)].pop()?.[1] ?? '?';
  });
  check('7.4 ningun efecto abre una terminal: solo el `+`, el enlace y desplegar la consola',
    json(openers.sort()) === json(['openConsoleHere', 'unfoldConsole']), json(openers));
  check('7.5 la barra plegada despliega por `unfoldConsole`, y el ▾ solo pliega',
    /className="strip-collapsed"\s+onClick=\{unfoldConsole\}/.test(app) && /onCollapse=\{narrow \? \(\) => changeNarrowView\('chat'\) : toggleConsole\}/.test(app));
}

// --- 8. La barra de proyectos se esconde al abrir una sesion nueva desde ella (22-10-2026) --
//
// El `+` de un proyecto (y su menu), el de proyecto nuevo y la rama aparte la
// esconden cuando llega la pestana; una sesion del historial no, para poder
// mirar varias seguidas. Lo que se rompe sin verse: que uno de los tres caminos
// deje de esconderla, o que el del historial empiece a hacerlo.
{
  const app = await readFile(new URL('../../web/src/App.tsx', import.meta.url), 'utf8');
  const worktrees = await readFile(new URL('../../web/src/useWorktrees.ts', import.meta.url), 'utf8');
  const handler = (prop) => app.match(new RegExp(`${prop}=\\{[\\s\\S]*?\\n      \\}\\}`))?.[0] ?? '';
  check('8.1 el + de un proyecto y su menu la esconden cuando llega la pestana',
    /openTerminal\(\{[\s\S]*?onOpened: hideSidebarAfterOpen \}\);/.test(handler('onOpenProject')));
  check('8.2 la rama aparte tambien: el dialogo avisa cuando llega la pestana de la rama',
    /hideSidebarAfterOpen,?\s*\);/.test(handler('onNewWorktree')) && /createOpened\.current = null;\s*opened\?\.\(\);/.test(worktrees));
  check('8.3 proyecto nuevo tambien', /setPickerFor\(null\);\s*openTerminal\(\{ cwd, onOpened: hideSidebarAfterOpen \}\);/.test(app));
  check('8.4 una sesion del historial no la esconde', handler('onOpenSession').length > 0 && !/hideSidebar/.test(handler('onOpenSession')));
  check('8.5 en la vista angosta no la toca: ahi es un cajon, que ya se cierra al elegir',
    /const hideSidebarAfterOpen = useCallback\(\(\) => \{\s*if \(narrow\) return;/.test(app));
}

// --- 9. La status line que falta para programar (27-10-2026) ---------------------------
//
// Pedido del usuario: la ayuda de la casilla nombraba a Antigravity CLI tambien
// a quien no la usa o ya tiene su status line. Ahora la nombra una linea aparte,
// solo con la casilla encendida y solo para la CLI instalada y prendida que la
// necesita para programar. Lo que se rompe sin verse: que vuelva la frase fija,
// que la linea salga con la status line activa, o que el pedido para un agente
// cambie el comando (en Windows, una comilla de mas o de menos lo rompe).
{
  const missing = { state: 'missing', settingsPath: 's', scriptPath: 'x', fragment: '{}' };
  const cli = (id, over = {}) => ({
    id,
    label: id,
    available: true,
    statusLine: missing,
    capabilities: { scheduledSend: false },
    ...over,
  });
  const ids = (agents, disabled = []) => json(scheduledNeedsStatusLine(agents, disabled).map((agent) => agent.id));
  check('9.1 instalada, sin status line y sin programar: se nombra', ids([cli('antigravity')]) === json(['antigravity']));
  for (const state of ['other-command', 'disabled', 'unreadable']) {
    check(`9.2 con la status line "${state}" tambien`, ids([cli('antigravity', { statusLine: { ...missing, state } })]) === json(['antigravity']));
  }
  check('9.3 con la status line activa, no (el caso del usuario)',
    ids([cli('antigravity', { statusLine: { ...missing, state: 'active' } })]) === '[]');
  check('9.4 no instalada, no', ids([cli('antigravity', { available: false })]) === '[]');
  check('9.5 apagada en Ajustes, no', ids([cli('antigravity')], ['antigravity']) === '[]');
  check('9.6 sin status line opcional (Codex, OpenCode, Pi), no', ids([cli('codex', { statusLine: null })]) === '[]');
  check('9.7 una CLI que ya programa sin ella, no', ids([cli('otra', { capabilities: { scheduledSend: true } })]) === '[]');
  check('9.8 Claude Code: su status line del plan no cuenta (va en planLimitsSetup)',
    ids([cli('claude-code', { statusLine: null, capabilities: { scheduledSend: true }, planLimitsSetup: missing })]) === '[]');

  const locales = ['en', 'es', 'de', 'fr', 'pt-BR', 'ru', 'ja', 'ko', 'zh-CN'];
  const named = [];
  for (const locale of locales) {
    const texts = JSON.parse(await readFile(new URL(`../../web/src/i18n/locales/${locale}.json`, import.meta.url), 'utf8'));
    if (/Antigravity|Claude|Codex|OpenCode|\bPi\b/.test(texts['settings.scheduled.hint'])) named.push(locale);
  }
  check('9.9 la ayuda de la casilla no nombra ninguna CLI, en los nueve idiomas', named.length === 0, json(named));

  const dialog = await readFile(new URL('../../web/src/SettingsDialog.tsx', import.meta.url), 'utf8');
  check('9.10 la linea sale solo con la casilla encendida',
    /\{shownScheduled &&\s*scheduledNeedsStatusLine\(agents, shownDisabled\)/.test(dialog));

  for (const [label, fragment, settingsPath] of [
    ['Antigravity CLI', statusLineFragment('C:\\Users\\u\\AppData\\Roaming\\agent-workbench\\integrations\\antigravity-statusline.mjs', 'win32'),
      'C:\\Users\\u\\.gemini\\antigravity-cli\\settings.json'],
    ['Claude Code', claudeStatusLineFragment('C:\\Users\\u\\AppData\\Roaming\\agent-workbench\\integrations\\claude-statusline.mjs', 'win32'),
      'C:\\Users\\u\\.claude\\settings.json'],
  ]) {
    const prompt = statusLineAgentPrompt({ settingsPath, fragment }, label) ?? '';
    check(`9.11 ${label}: el pedido lleva el fragmento tal cual, el archivo y la CLI`,
      fragment !== null && prompt.includes(fragment) && prompt.includes(settingsPath) && prompt.includes(label), prompt.slice(0, 80));
  }
  check('9.12 sin fragmento posible no hay pedido', statusLineAgentPrompt({ settingsPath: 's', fragment: null }, 'X') === null);
}

await rm(workDir, { recursive: true, force: true });
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
