/**
 * Lo que la cabecera y los carteles dicen de las CLIs, a partir de `hello`.
 *
 * Desde el protocolo 6 el servidor anuncia una **lista** de CLIs, cada una con
 * su version, su texto de ausencia y su aviso de entorno. La interfaz, en
 * cambio, sigue hablando de "la CLI": la etiqueta `CLI x.y.z`, el cartel de CLI
 * ausente y el del marcador. Esto traduce una cosa a la otra, y la regla es que
 * con una sola CLI registrada salga **exactamente** lo que salia antes.
 *
 * Es una funcion pura y sin React a proposito: lo prueba
 * `check-agent-registry.mjs`, que es lo unico que ve si la etiqueta o el cartel
 * cambiaron sin querer.
 */

import {
  PROTOCOL_VERSION,
  type AgentInfo,
  type EnvironmentNoticeId,
} from '@agent-workbench/shared';
import { t } from './i18n/index.js';
import { serverTextMessage } from './i18n/server-text.js';

export interface AgentSummary {
  /**
   * false cuando no hay ninguna CLI instalada: la UI lo explica y no abre
   * pestanas. Antes del primer `hello` es true, igual que siempre: arrancar
   * con los botones apagados hasta que conecte seria un parpadeo.
   */
  cliAvailable: boolean;
  /** Para la cabecera. Con varias, cada una con su nombre. */
  cliVersion: string | null;
  /**
   * Texto listo para mostrar cuando `cliAvailable` es false: la CLI que falta,
   * o que el servidor es de una version anterior y hay que reiniciarlo.
   */
  cliMissingMessage: string | null;
  /** El primer aviso de entorno que haya levantado alguna CLI. */
  environmentNotice: EnvironmentNoticeId | null;
}

/**
 * El texto cuando el `hello` viene de un servidor anterior a esta pagina.
 *
 * Pasa con `pnpm dev`: cambiar de rama con el servidor corriendo recarga la web
 * nueva dentro del proceso viejo, que no se reinicia solo. Ese `hello` no trae
 * `agents`, y leido tal cual dice "ninguna CLI" sin ningun cartel: la barra
 * apagada, sin pestanas nuevas y sin controles. No se intenta adivinar que CLI
 * tiene ese servidor ni que sabe hacer; se dice que hay que reiniciarlo.
 */
export function outdatedServerMessage(serverProtocolVersion: number): string {
  return t('summary.outdatedServer', { server: serverProtocolVersion, page: PROTOCOL_VERSION });
}

/**
 * El cartel cuando no hay ninguna CLI instalada.
 *
 * El texto de la **primera** registrada —la de siempre— y una linea que nombra
 * las demas, no los textos de instalacion de todas: quien usaba la app con una
 * sola CLI tiene que seguir viendo el cartel de siempre, y no las instrucciones
 * de instalar otra que no pidio. null si la primera no trae texto.
 */
function missingCliMessage(agents: readonly AgentInfo[]): string | null {
  const [first, ...others] = agents;
  if (first === undefined || first.missingMessage === null) return null;
  const missing = serverTextMessage(first.missingMessage);
  if (others.length === 0) return missing;
  return `${missing}\n${t('summary.alsoWorksWith', { names: others.map((agent) => agent.label).join(', ') })}`;
}

/**
 * La version de una CLI con su nombre, para la cabecera con varias.
 *
 * Sin repetir el nombre si la version ya lo dice: las CLIs imprimen cosas como
 * `2.1.270 (Claude Code)` o `codex-cli 0.154.0`, y anteponerles la etiqueta
 * dejaba `Claude Code 2.1.270 (Claude Code)`. Se compara sin mayusculas, porque
 * lo que importa es que el nombre ya se lea.
 */
function versionWithLabel(agent: AgentInfo): string {
  const version = agent.version ?? '?';
  return version.toLowerCase().includes(agent.label.toLowerCase())
    ? version
    : `${agent.label} ${version}`;
}

export function summarizeAgents(
  agents: readonly AgentInfo[],
  helloReceived: boolean,
  /** El `protocolVersion` de ese `hello`. Sin `hello`, no se mira. */
  serverProtocolVersion: number = PROTOCOL_VERSION,
): AgentSummary {
  if (helloReceived && serverProtocolVersion < PROTOCOL_VERSION) {
    return {
      cliAvailable: false,
      cliVersion: null,
      cliMissingMessage: outdatedServerMessage(serverProtocolVersion),
      environmentNotice: null,
    };
  }
  /*
    Al reves (hito 34, D11): la pagina quedo abierta de antes y el servidor ya
    es el nuevo. Sus mensajes pueden tener otra forma —los errores dejaron de
    traer la frase armada—, y sin esto se perderian callados.
  */
  if (helloReceived && serverProtocolVersion > PROTOCOL_VERSION) {
    return {
      cliAvailable: false,
      cliVersion: null,
      cliMissingMessage: t('summary.newerServer', { server: serverProtocolVersion, page: PROTOCOL_VERSION }),
      environmentNotice: null,
    };
  }

  const available = agents.filter((agent) => agent.available);

  let cliVersion: string | null = null;
  if (available.length === 1) {
    cliVersion = available[0]?.version ?? null;
  } else if (available.length > 1) {
    cliVersion = available.map(versionWithLabel).join(' · ');
  }

  const noneAvailable = helloReceived && available.length === 0;

  return {
    cliAvailable: !helloReceived || available.length > 0,
    cliVersion,
    cliMissingMessage: noneAvailable ? missingCliMessage(agents) : null,
    environmentNotice: agents.find((agent) => agent.environmentNotice !== null)?.environmentNotice ?? null,
  };
}
