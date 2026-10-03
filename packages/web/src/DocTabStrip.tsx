/**
 * La fila de pestanas de documentos de Archivos y Planes (Hito 40, §6.31).
 *
 * Va donde estaba `← Planes` / `← Archivos` y el titulo del abierto: la primera
 * es la lista —el arbol, o la lista de planes— y al lado van los documentos
 * abiertos, cada uno con su ×. Mismas solapas que las notas y la consola
 * (`.strip-tab`, §6.7): se encogen, la × aparece en la activa o bajo el mouse, y
 * la fila se desplaza de costado si no entran.
 */

import type { OpenDoc } from './doc-tabs.js';
import { t } from './i18n/index.js';

interface DocTabStripProps {
  /** El nombre de la lista: "Archivos" o "Planes". */
  listLabel: string;
  docs: readonly OpenDoc[];
  active: string | null;
  /** El tooltip de cada pestana: la ruta entera. */
  tooltipOf: (doc: OpenDoc) => string;
  /** Lo que dice cada pestana, si no es su titulo guardado: el encabezado de un plan ya leido. */
  labelOf?: (doc: OpenDoc) => string;
  onShowList: () => void;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
}

export function DocTabStrip({
  listLabel,
  docs,
  active,
  tooltipOf,
  labelOf = (doc) => doc.title,
  onShowList,
  onSelect,
  onClose,
}: DocTabStripProps): JSX.Element {
  return (
    <div className="panel-subhead doc-strip">
      <button
        className={`doc-strip-list${active === null ? ' is-active' : ''}`}
        onClick={onShowList}
        title={t('docs.backToList')}
      >
        {active === null ? listLabel : `← ${listLabel}`}
      </button>
      <div className="strip-tabs doc-tabs">
        {docs.map((doc) => (
          <div key={doc.key} className={`strip-tab${doc.key === active ? ' is-active' : ''}`}>
            <button className="strip-tab-label" onClick={() => onSelect(doc.key)} title={tooltipOf(doc)}>
              {labelOf(doc)}
            </button>
            <button className="strip-tab-close" onClick={() => onClose(doc.key)} title={t('docs.tab.close')}>
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
