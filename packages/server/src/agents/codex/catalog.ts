import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { ModelOption } from '@agent-workbench/shared';
import type { CliLocation } from '../locate.js';

/** Desde 0.164 la TUI acepta argumentos en /model. */
export function supportsCodexModelCommand(version: string | null): boolean {
  const match = version?.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 164;
}

/** `/permissions` supports explicit profiles and approval settings in 0.166+. */
export function supportsCodexPermissionCommand(version: string | null): boolean {
  const match = version?.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 166;
}

/** Convierte el catalogo de la CLI sin aceptar texto que pueda alterar un comando. */
export function codexModelOptions(data: unknown): ModelOption[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const model = entry as Record<string, unknown>;
    const id = model['model'];
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id) || model['hidden'] === true) return [];
    const supported = Array.isArray(model['supportedReasoningEfforts']) ? model['supportedReasoningEfforts'] : [];
    const efforts = supported.flatMap((item: unknown) => {
      const level = item && typeof item === 'object' ? (item as Record<string, unknown>)['reasoningEffort'] : null;
      return typeof level === 'string' && /^[a-z]{1,20}$/.test(level) ? [level] : [];
    });
    const defaultEffort = typeof model['defaultReasoningEffort'] === 'string'
      && /^[a-z]{1,20}$/.test(model['defaultReasoningEffort'])
      && efforts.includes(model['defaultReasoningEffort'])
      ? model['defaultReasoningEffort']
      : null;
    return [{
      value: id,
      label: typeof model['displayName'] === 'string' ? model['displayName'] : id,
      family: id,
      long: false,
      window: null,
      supportedEfforts: efforts,
      isDefault: model['isDefault'] === true,
      defaultEffort,
    }];
  });
}

/** Consulta el protocolo por stdio sin leer archivos de configuracion desde AWB. */
export async function loadCodexModels(location: CliLocation): Promise<ModelOption[]> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(location.file, [...location.prefixArgs, 'app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { resolve([]); return; }
    let done = false;
    const models: ModelOption[] = [];
    let pages = 0;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lines.close();
      child.stdin?.end();
      child.kill();
      resolve(models);
    };
    const timer = setTimeout(finish, 20_000);
    const lines = readline.createInterface({ input: child.stdout! });
    const send = (value: object) => child.stdin?.write(JSON.stringify(value) + '\n');
    lines.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as { id?: number; result?: { data?: unknown; nextCursor?: unknown }; error?: unknown };
        if (msg.id === 1) {
          if (msg.error) { finish(); return; }
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'model/list', params: { limit: 100, includeHidden: false } });
        } else if (msg.id === 2) {
          if (msg.error || !msg.result) { finish(); return; }
          models.push(...codexModelOptions(msg.result.data));
          pages += 1;
          if (typeof msg.result.nextCursor === 'string' && msg.result.nextCursor && pages < 10) send({ id: 2, method: 'model/list', params: { limit: 100, cursor: msg.result.nextCursor } });
          else finish();
        }
      } catch { /* Ignora avisos que no son JSON. */ }
    });
    child.on('error', finish);
    child.on('exit', finish);
    child.stdin?.on('error', finish);
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-workbench', version: '1' }, capabilities: {} } });
  });
}
