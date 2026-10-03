/**
 * Los documentos de la conversacion, renderizados.
 *
 * Un plan del modo plan se escribe en un `.md` fuera del proyecto y la unica
 * forma de leerlo era abrirlo con la aplicacion del sistema — el hilo mostraba
 * la ruta y nada mas. Aca se lee donde se lo escribio.
 *
 * Desde el hito 31 son tres origenes, y los dos nuevos son el pedido que lo
 * motivo: el `.md` que el agente escribe **dentro del proyecto** y el que deja
 * en la carpeta temporal de la sesion. De esos se muestra ademas su ruta
 * relativa, que es lo que los distingue entre si; la de un plan de la CLI es
 * siempre la misma y no aporta nada.
 *
 * Desde el Hito 40 cada documento abierto es una pestana al lado de `← Planes`
 * (§6.31), y cambiar de pestana de proyecto no los cierra: la lista sigue a la
 * pestana activa, y los abiertos los recuerda `useDocuments` por pestana. El
 * contenido se pide al mostrarse, no antes: la lista son tres o cuatro nombres;
 * el contenido son diez o quince KB de markdown cada uno.
 *
 * Se renderiza con el mismo `<Markdown>` del hilo: un plan es texto para leer,
 * y verlo con sus titulos y sus listas es la mitad del pedido.
 */

import { useEffect } from 'react';
import type { SessionPlan } from '@agent-workbench/shared';
import { DocTabStrip } from './DocTabStrip.js';
import type { OpenDoc } from './doc-tabs.js';
import { DocumentViewer } from './DocumentViewer.js';
import { formatBytes, formatWhen } from './i18n/format.js';
import { t } from './i18n/index.js';
import { tRich } from './i18n/rich.js';
import type { DocStripView } from './useDocuments.js';
import type { PlansView } from './usePlans.js';

/** El primer encabezado del plan, que casi siempre dice de que se trata. */
function headingOf(text: string): string | null {
  for (const line of text.split('\n', 40)) {
    const match = /^#{1,3}\s+(.+)$/.exec(line.trim());
    if (match !== null) return (match[1] ?? '').trim();
  }
  return null;
}

export function PlansPanel({ view, docs }: { view: PlansView; docs: DocStripView }): JSX.Element {
  const { plans } = view;
  const activeDoc = docs.active === null ? null : (docs.docs.find((doc) => doc.key === docs.active) ?? null);
  const activeContent = activeDoc === null ? undefined : docs.content(activeDoc.key);

  /*
    Una pestana que vuelve sin contenido —despues de F5— lo pide al mostrarse,
    pero recien cuando llego la lista: el servidor lee un plan solo si la
    conversacion lo nombro, y eso lo sabe despues de leerla. Pedido antes,
    contestaba que no podia. La lista llega sola y solo si tiene algo.
  */
  const missing = activeDoc !== null && activeContent === undefined && plans.length > 0;
  useEffect(() => {
    if (missing && activeDoc !== null) docs.reload(activeDoc.key);
  }, [missing, activeDoc?.key]);

  /** El encabezado del plan si ya se leyo; si no, el nombre del archivo. La ref no se muestra nunca. */
  const labelOf = (doc: OpenDoc): string => {
    const loaded = docs.content(doc.key)?.loaded;
    return loaded?.kind === 'plan' ? (headingOf(loaded.plan.text) ?? doc.title) : doc.title;
  };
  // La ruta de un documento del proyecto o de la temporal; la de un plan de la CLI viaja vacia.
  const tooltipOf = (doc: OpenDoc): string => {
    const path = plans.find((plan) => plan.fileName === doc.key)?.path ?? '';
    return path.length > 0 ? path : labelOf(doc);
  };

  return (
    <div className="panel-body">
      {docs.docs.length > 0 && (
        <DocTabStrip
          listLabel={t('panel.tab.plans')}
          docs={docs.docs}
          active={docs.active}
          tooltipOf={tooltipOf}
          labelOf={labelOf}
          onShowList={docs.showList}
          onSelect={docs.select}
          onClose={docs.close}
        />
      )}

      {activeDoc !== null ? (
        <DocumentViewer
          key={activeDoc.key}
          doc={activeDoc}
          content={activeContent}
          readingText={t('plans.loading')}
          truncatedText={t('plans.truncated')}
          onReload={() => docs.reload(activeDoc.key)}
          onModeChange={(mode) => docs.setMode(activeDoc.key, mode)}
          onOpenWithSystem={null}
          initialScroll={docs.scrollOf(activeDoc.key)}
          onScrollChange={(top) => docs.rememberScroll(activeDoc.key, top)}
        />
      ) : (
        <div className="panel-scroll">
          {plans.length === 0 ? (
            <p className="panel-note">{tRich('plans.empty')}</p>
          ) : (
            <ul className="plan-list">
              {[...plans].reverse().map((plan) => (
                <PlanRow key={plan.fileName} plan={plan} onOpen={() => docs.open({ key: plan.fileName, title: plan.title })} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Una fila de la lista.
 *
 * Un documento que ya no esta en disco se muestra igual y se dice: la
 * conversacion lo nombro, y hacerlo desaparecer dejaria un hueco sin
 * explicacion. No se puede abrir, y por eso no es un boton. Pasa de verdad con
 * los tres origenes: una linea `plan_mode` puede anunciar un archivo que la CLI
 * todavia no escribio, y lo de la carpeta temporal se borra solo con el tiempo.
 */
function PlanRow({ plan, onOpen }: { plan: SessionPlan; onOpen: () => void }): JSX.Element {
  // La carpeta, que es lo que distingue dos documentos con el mismo nombre. La
  // de un plan de la CLI es siempre la misma y viaja vacia.
  const where = plan.path.length > 0 ? plan.path : null;

  if (!plan.exists) {
    return (
      <li className="plan-row plan-row-missing" title={where ?? t('plans.missingTitle')}>
        <span className="plan-name">{plan.title}</span>
        {where !== null && <span className="plan-path">{where}</span>}
        <span className="plan-meta">{t('plans.missing')}</span>
      </li>
    );
  }

  return (
    <li>
      <button className="plan-row" onClick={onOpen} title={where ?? undefined}>
        <span className="plan-name">{plan.title}</span>
        {where !== null && <span className="plan-path">{where}</span>}
        <span className="plan-meta">
          {formatWhen(plan.modifiedAt)} · {formatBytes(plan.sizeBytes)}
        </span>
      </button>
    </li>
  );
}
