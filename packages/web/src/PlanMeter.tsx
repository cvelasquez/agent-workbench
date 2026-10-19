/**
 * El medidor del plan (hito 47, §6.37): cuanto se uso de los limites de la
 * cuenta de la CLI de la pestana (las 5 horas y la semana) y cuanto falta para
 * que se reinicien. Vive en la fila del buscador, al lado del de contexto.
 *
 * Lo que decide que se ve esta en `plan-meter.ts`, que prueba el chequeo. Aca
 * solo se dibuja, y se redibuja solo cada medio minuto: el tiempo que falta
 * corre aunque no llegue nada nuevo, y una ventana que se reinicio desaparece.
 *
 * Cuando falta sitio lo resuelve el CSS (`@container thread-toolbar`): primero
 * se va la ventana que no es la prioritaria, despues la palabra y la barra, y
 * queda `11 % · 5d 10h`.
 */

import { useEffect, useState } from 'react';
import type { PlanLimitWindow, StatusLineState } from '@agent-workbench/shared';
import { t } from './i18n/index.js';
import {
  PLAN_DANGER_PERCENT,
  PLAN_METER_TICK_MS,
  planIdleState,
  planLevel,
  planMeterTitle,
  planMeterView,
  planPercentText,
  planSetupTitle,
  planTimeLeftText,
  planWindowLabel,
} from './plan-meter.js';

interface PlanMeterProps {
  /** Lo que se sabe de la cuenta de la CLI de la pestana; [] si nada. */
  windows: readonly PlanLimitWindow[];
  /**
   * Como esta la status line que publica los limites, en la CLI que solo los
   * publica por ahi (`AgentInfo.planLimitsSetup`); null en las demas.
   */
  setupState: StatusLineState | null;
  /** Abre el dialogo de esa status line. */
  onConfigure?: () => void;
}

export function PlanMeter({ windows, setupState, onConfigure }: PlanMeterProps): JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), PLAN_METER_TICK_MS);
    return () => window.clearInterval(timer);
  }, [windows]);

  const view = planMeterView(windows, now);

  if (view === null) {
    const idle = planIdleState(setupState);
    if (idle === 'hidden' || setupState === null) return null;
    if (idle === 'configure' && onConfigure === undefined) return null;
    return (
      <div className="meter meter-idle meter-compact plan-meter" title={planSetupTitle(setupState)}>
        <span className="meter-label">{t('plan.label')}</span>
        {idle === 'configure' ? (
          <button className="link-button" onClick={onConfigure}>
            {t('meter.configure')}
          </button>
        ) : (
          <span className="meter-value">{t('plan.noData')}</span>
        )}
      </div>
    );
  }

  return (
    <div className="meter meter-compact plan-meter" title={planMeterTitle(view, now)}>
      {view.shown.map((window) => {
        const level = planLevel(window.usedPercent);
        const left = planTimeLeftText(window, now);
        const priority = window.id === view.priorityId;
        return (
          <span key={window.id} className={`plan-window ${priority ? 'plan-window-priority' : 'plan-window-extra'}`}>
            <span className="meter-label plan-label">{planWindowLabel(window)}</span>
            <span className="meter-bar meter-bar-inline plan-bar">
              <span
                className={`meter-fill meter-fill-${level}`}
                style={{ width: `${Math.min(window.usedPercent, 100)}%` }}
              />
            </span>
            <span className="meter-value">
              <span className={window.usedPercent >= PLAN_DANGER_PERCENT ? 'plan-danger' : undefined}>
                {planPercentText(window.usedPercent)}
              </span>
              {left !== null && <span className="meter-dim"> · {left}</span>}
            </span>
          </span>
        );
      })}
    </div>
  );
}
