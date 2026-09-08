/**
 * Diff renderizado linea por linea.
 *
 * Dos cosas que valen la pena:
 *
 *  - **Los numeros de linea vienen del servidor.** Es la misma cuenta que
 *    haria el navegador, hecha una sola vez y en un solo lugar.
 *  - **El `+` y el `-` se dibujan aparte del texto.** Asi seleccionar y copiar
 *    el diff no arrastra los marcadores, que es lo que uno quiere cuando copia
 *    una linea para pegarla en otro lado.
 */

import type { DiffLine, GitDiff } from '@agent-workbench/shared';

const MARKER: Readonly<Record<DiffLine['kind'], string>> = {
  added: '+',
  removed: '-',
  context: ' ',
  hunk: '',
  meta: '',
};

interface DiffViewProps {
  diff: GitDiff;
}

export function DiffView({ diff }: DiffViewProps): JSX.Element {
  if (diff.binary) {
    return <p className="panel-note">Archivo binario: no hay diff que mostrar.</p>;
  }

  if (diff.lines.length === 0) {
    return <p className="panel-note">{diff.message ?? 'Sin cambios.'}</p>;
  }

  return (
    <div className="panel-scroll">
      <div className="diff">
        {diff.lines.map((line, index) => (
          <div className={`diff-line diff-line-${line.kind}`} key={index}>
            <span className="diff-num" aria-hidden="true">
              {line.oldLine ?? ''}
            </span>
            <span className="diff-num" aria-hidden="true">
              {line.newLine ?? ''}
            </span>
            <span className="diff-marker" aria-hidden="true">
              {MARKER[line.kind]}
            </span>
            <span className="diff-text">{line.text}</span>
          </div>
        ))}
      </div>

      {diff.truncated && (
        <p className="panel-note">
          El diff se cortó por tamaño. El archivo completo se ve mejor fuera de este
          panel.
        </p>
      )}
    </div>
  );
}
