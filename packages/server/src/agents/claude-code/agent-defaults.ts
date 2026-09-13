/**
 * Con que modelo y esfuerzo va a arrancar una pestana, antes de que conteste.
 *
 * El combo de la barra muestra **lo observado en el archivo de sesion**, y esa
 * sigue siendo la verdad (ver `agent-controls.ts`). Pero hasta la primera
 * respuesta el archivo no tiene ninguna linea `assistant`, y el combo se
 * quedaba en "sin datos" mientras la CLI, a dos centimetros, ya anunciaba
 * "Opus 5 with xhigh effort" en su banner. Los dos decian la verdad y se
 * contradecian.
 *
 * Este modulo cubre ese hueco leyendo de donde la CLI saca el banner: sus
 * archivos de configuracion. Lo que sale de aca es **provisional** y lo pisa la
 * primera respuesta real; sirve para que el combo no arranque vacio.
 *
 * Que se lee, exactamente y nada mas:
 *
 *  - `<cwd>/.claude/settings.local.json`
 *  - `<cwd>/.claude/settings.json`
 *  - `~/.claude/settings.json`
 *
 * y de cada uno **solo** las claves `model` y `modelSettings`. La carpeta no se
 * recorre y `.credentials.json` no se toca ni se nombra: la regla 2.1 sigue
 * intacta, porque esto no es autenticacion sino la preferencia de modelo que el
 * propio usuario escribio.
 *
 * **La ventana de contexto solo sale de lo que el alias declara.** Un `opus`
 * pelado no dice si son 200k o 1M, y no se completa con el historial de la
 * instalacion aunque el registro de variantes lo tenga a mano: medido el
 * 02-09-2026 sobre los 12 archivos mas recientes de esta maquina, los tres
 * ultimos traen `claude-opus-5` **solo**, sin ningun `[1m]` al lado, mientras
 * la sesion que estaba corriendo iba por 255k de contexto. Es decir que la
 * observacion mas nueva del historial habria anunciado 200k en una pestana de
 * 1M. Un alias sin variante deja la ventana en null y el medidor dibuja la
 * barra vacia sin limite hasta la primera respuesta, que es el unico dato que
 * no se puede discutir.
 *
 * Esto revierte a proposito una decision anterior —"leer su configuracion seria
 * meterse donde no nos llaman"— que el usuario pidio cambiar: el combo tiene
 * que decir con que esta trabajando desde el primer momento. El costo es que la
 * cadena de precedencia esta reimplementada aca y puede desincronizarse de la
 * CLI; por eso el valor se marca como provisional en la interfaz en vez de
 * presentarse como observado.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentDefaults } from '@agent-workbench/shared';
import { ModelVariantRegistry } from './model-variants.js';

/**
 * Lo que se puede leer de la configuracion, y nada mas.
 *
 * La ventana de contexto que completa `AgentDefaults` no sale de aca: el alias
 * configurado no dice la variante (§4.5.1), y pasarlo por la tabla de ventanas
 * devuelve null para `opus` y un 200k enganoso para un id completo. Quien sabe
 * con que variante trabaja esta instalacion es el registro de variantes, que
 * vive del historial.
 */
type ConfiguredAgent = Omit<AgentDefaults, 'contextWindow'>;

/**
 * Registro **sin observaciones**, y a proposito (CLAUDE.md 5.4.1).
 *
 * Vacio, `windowForConfigured` solo responde a los alias que declaran variante
 * (`opus[1m]`) y devuelve null para el resto. Pasarle el registro de la
 * instalacion completaria mas casos, y es justo lo que la medicion del §4.5.1
 * desaconseja: los archivos mas recientes de esta maquina dicen
 * `claude-opus-5` a secas mientras la sesion viva iba por 255k, asi que el
 * historial habria anunciado 200k para una sesion de 1M. Usarlo asi deja la
 * regla en un solo lugar en vez de copiarla aca.
 */
const NO_OBSERVATIONS = new ModelVariantRegistry();

/** Familias conocidas, para casar el alias de `model` con `modelSettings`. */
const FAMILIES: readonly string[] = ['opus', 'sonnet', 'haiku', 'fable'];

interface SettingsShape {
  model?: unknown;
  modelSettings?: unknown;
}

/**
 * Lee un settings y se queda solo con lo que nos interesa.
 *
 * Un archivo ausente o roto no es un error: la CLI misma sigue andando sin el,
 * y un combo vacio es mejor que un arranque fallido.
 */
async function readSettings(file: string): Promise<SettingsShape | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    return { model: record['model'], modelSettings: record['modelSettings'] };
  } catch {
    return null;
  }
}

/**
 * El nivel de esfuerzo configurado para un alias de modelo.
 *
 * `model` es un alias (`opus`) y `modelSettings` esta indexado por id
 * (`claude-opus-5`), asi que se casan por familia: es lo unico estable entre
 * versiones, porque los sufijos de fecha cambian solos.
 */
function effortFor(model: string, modelSettings: unknown): string | null {
  if (typeof modelSettings !== 'object' || modelSettings === null) return null;

  const family = FAMILIES.find((candidate) => model.includes(candidate));
  if (family === undefined) return null;

  for (const [id, value] of Object.entries(modelSettings as Record<string, unknown>)) {
    if (!id.includes(family)) continue;
    if (typeof value !== 'object' || value === null) continue;
    const level = (value as Record<string, unknown>)['effortLevel'];
    if (typeof level === 'string' && level.length > 0) return level;
  }
  return null;
}

/**
 * Modelo y esfuerzo previstos para una pestana.
 *
 * Precedencia de mas a menos especifico, la misma que documenta la CLI para lo
 * que podemos leer: local del proyecto, compartido del proyecto, del usuario.
 * Lo que no sepamos queda en `null` y el combo vuelve a decir "sin datos", que
 * es la respuesta honesta.
 */
export async function readAgentDefaults(cwd: string): Promise<AgentDefaults> {
  const withWindow = (configured: ConfiguredAgent): AgentDefaults => ({
    ...configured,
    contextWindow: NO_OBSERVATIONS.windowForConfigured(configured.model),
  });

  const candidates = [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(homedir(), '.claude', 'settings.json'),
  ];

  for (const file of candidates) {
    const settings = await readSettings(file);
    if (settings === null) continue;
    const { model } = settings;
    if (typeof model !== 'string' || model.length === 0) continue;
    return withWindow({ model, effort: effortFor(model, settings.modelSettings) });
  }

  return withWindow({ model: null, effort: null });
}
