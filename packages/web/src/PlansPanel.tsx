/**
 * Los planes de la conversacion, renderizados.
 *
 * Un plan del modo plan se escribe en un `.md` fuera del proyecto y hasta ahora
 * la unica forma de leerlo era abrirlo con la aplicacion del sistema — el hilo
 * mostraba la ruta y nada mas. Aca se lee donde se lo escribio.
 *
 * Sigue las mismas dos reglas que los otros paneles de la columna:
 *
 *  - **El contenido reemplaza a la lista**, con una vuelta atras. Partir la
 *    columna en dos deja las dos mitades ilegibles.
 *  - **Se pide al abrir, no antes.** La lista son tres o cuatro nombres; el
 *    contenido son diez o quince KB de markdown cada uno.
 *
 * Se renderiza con el mismo `<Markdown>` del hilo: un plan es texto para leer,
 * y verlo con sus titulos y sus listas es la mitad del pedido.
 */

import type { SessionPlan } from '@agent-workbench/shared';
import { formatWhen } from './format-when.js';
import { Markdown } from './Markdown.js';
import type { PlansView } from './usePlans.js';

function formatSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

/** El primer encabezado del plan, que casi siempre dice de que se trata. */
function headingOf(text: string): string | null {
  for (const line of text.split('\n', 40)) {
    const match = /^#{1,3}\s+(.+)$/.exec(line.trim());
    if (match !== null) return (match[1] ?? '').trim();
  }
  return null;
}

export function PlansPanel({ view }: { view: PlansView }): JSX.Element {
  const { plans, open, loading, openPlan, closePlan } = view;

  if (open !== null || loading !== null) {
    const title = open === null ? loading : (headingOf(open.text) ?? open.fileName);
    return (
      <div className="panel-body">
        <div className="panel-subhead">
          <button className="link-button" onClick={closePlan}>
            ← Planes
          </button>
          <span className="panel-subhead-title" title={open?.fileName ?? undefined}>
            {title}
          </span>
        </div>

        {open === null ? (
          <p className="panel-note">Leyendo el plan…</p>
        ) : (
          <div className="panel-scroll">
            <div className="plan-body">
              <Markdown text={open.text} />
            </div>
            {open.truncated && (
              <p className="panel-note">El plan se cortó por tamaño.</p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="panel-body">
      <div className="panel-scroll">
        {plans.length === 0 ? (
          <p className="panel-note">
            Esta conversación todavía no escribió ningún plan. Aparecen acá los que el
            agente guarda al trabajar en modo plan.
          </p>
        ) : (
          <ul className="plan-list">
            {[...plans].reverse().map((plan) => (
              <PlanRow key={plan.fileName} plan={plan} onOpen={() => openPlan(plan.fileName)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Una fila de la lista.
 *
 * Un plan que ya no esta en disco se muestra igual y se dice: la conversacion
 * lo nombro, y hacerlo desaparecer dejaria un hueco sin explicacion. No se
 * puede abrir, y por eso no es un boton.
 */
function PlanRow({ plan, onOpen }: { plan: SessionPlan; onOpen: () => void }): JSX.Element {
  if (!plan.exists) {
    return (
      <li className="plan-row plan-row-missing" title="El archivo ya no está en disco">
        <span className="plan-name">{plan.title}</span>
        <span className="plan-meta">ya no está</span>
      </li>
    );
  }

  return (
    <li>
      <button className="plan-row" onClick={onOpen}>
        <span className="plan-name">{plan.title}</span>
        <span className="plan-meta">
          {formatWhen(plan.modifiedAt)} · {formatSize(plan.sizeBytes)}
        </span>
      </button>
    </li>
  );
}
