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
import { HIDEABLE_PANELS, parseHiddenPanels, serializeHiddenPanels, withPanelVisible } from '../../web/src/panel-visibility.ts';
import { effectivePanelTab, visiblePanelTabs } from '../../web/src/agent-ui.ts';
import { narrowViews } from '../../web/src/narrow-layout.ts';

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
    json(service.status()) === json({ consoleShell: 'auto', consoleShells: [{ id: 'pwsh', label: 'PowerShell 7' }, { id: 'git-bash', label: 'Git Bash' }], shellName: 'PowerShell', disabledAgents: [], disabledAtStart: ['opencode'] }),
    json(service.status()));
  await service.update({ consoleShell: 'git-bash' });
  check('4.2 elegir Git Bash avisa al registro y a todas las ventanas',
    json(changes) === '["Git Bash"]' && emitted.at(-1)?.shellName === 'Git Bash' && service.currentShell()?.name === 'Git Bash');
  const refused = await service.update({ consoleShell: 'cmd' }).then(() => null, (error) => error);
  check('4.3 una consola que no esta instalada no se acepta', refused instanceof AppSettingsChangeError && store.get().console.shell === 'git-bash');
  await service.update({ disabledAgents: ['codex'] });
  check('4.4 apagar una CLI se guarda, y lo del arranque no cambia hasta reiniciar',
    json(service.status().disabledAgents) === '["codex"]' && json(service.status().disabledAtStart) === '["opencode"]' && changes.length === 1);
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
}

// --- 6. Lo que se esconde -------------------------------------------------------------
{
  const hidden = parseHiddenPanels('notes, console,cli,chat,raro');
  check('6.1 se leen las que se conocen; la CLI y el chat no se pueden esconder',
    json([...hidden].sort()) === json(['console', 'notes']), json([...hidden]));
  check('6.2 ida y vuelta, en el orden de la lista', serializeHiddenPanels(hidden) === 'console,notes' && parseHiddenPanels('').size === 0);
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

await rm(workDir, { recursive: true, force: true });
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
