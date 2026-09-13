/**
 * La insignia con la CLI de una pestana o de una sesion: dos letras.
 *
 * Solo aparece cuando hay algo que distinguir (ver `tabBadgeVisible` y
 * `sessionAgentView`): con una sola CLI, una etiqueta que dice siempre lo mismo
 * es ruido en cada pestana.
 *
 * Va **dentro** de la etiqueta y antes del texto, no al lado. La pestana se
 * encoge hasta 44 px, que es lo que necesitan el punto de estado y la ×; una
 * insignia afuera subiria ese minimo, y adentro se recorta con la etiqueta.
 * El nombre entero va en el titulo.
 */

import type { AgentId, AgentInfo } from '@agent-workbench/shared';
import { AGENT_UI } from './agent-ui.js';

interface AgentBadgeProps {
  agent: AgentId;
  /** Para el titulo: el nombre de la CLI tal como lo anuncia el servidor. */
  agents: readonly AgentInfo[];
}

export function AgentBadge({ agent, agents }: AgentBadgeProps): JSX.Element {
  const label = agents.find((info) => info.id === agent)?.label ?? agent;
  return (
    <span className="agent-badge" title={label}>
      {AGENT_UI[agent].shortLabel}
    </span>
  );
}
