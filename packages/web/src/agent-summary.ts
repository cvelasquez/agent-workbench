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
  return (
    `El servidor que esta corriendo es de una version anterior a esta pagina ` +
    `(protocolo ${serverProtocolVersion}, esta pagina usa el ${PROTOCOL_VERSION}). ` +
    `Reinicialo y recarga la pagina.`
  );
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

  const available = agents.filter((agent) => agent.available);

  let cliVersion: string | null = null;
  if (available.length === 1) {
    cliVersion = available[0]?.version ?? null;
  } else if (available.length > 1) {
    cliVersion = available.map((agent) => `${agent.label} ${agent.version ?? '?'}`).join(' · ');
  }

  const missing = agents
    .map((agent) => agent.missingMessage)
    .filter((message): message is string => message !== null);
  const noneAvailable = helloReceived && available.length === 0;

  return {
    cliAvailable: !helloReceived || available.length > 0,
    cliVersion,
    cliMissingMessage: noneAvailable && missing.length > 0 ? missing.join('\n') : null,
    environmentNotice: agents.find((agent) => agent.environmentNotice !== null)?.environmentNotice ?? null,
  };
}
