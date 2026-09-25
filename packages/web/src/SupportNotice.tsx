/**
 * La sugerencia de apoyar el proyecto (§6.28): un cartel entre los de arriba,
 * una vez por versión, que se va solo a los 30 s o con "Ahora no".
 *
 * Que ya se mostró se anota al dibujarlo, no al cerrarlo: una recarga no lo
 * trae de vuelta. El enlace abre en otra pestaña; dentro de la app del
 * teléfono, el visor manda lo de afuera al navegador (§15.5).
 */

import { useEffect, useState } from 'react';
import { t } from './i18n/index.js';
import {
  APP_VERSION,
  SUPPORT_NOTICE_HIDE_MS,
  SUPPORT_NOTICE_STORAGE_KEY,
  SUPPORT_URL,
  parseStoredSupportNotice,
  shouldShowSupportNotice,
} from './support.js';
import { readStored, writeStored } from './window-prefs.js';

export function SupportNotice(): JSX.Element | null {
  const [visible, setVisible] = useState(() =>
    shouldShowSupportNotice(
      readStored<string | null>(SUPPORT_NOTICE_STORAGE_KEY, null, parseStoredSupportNotice),
      APP_VERSION,
    ),
  );

  useEffect(() => {
    if (!visible) return;
    writeStored(SUPPORT_NOTICE_STORAGE_KEY, APP_VERSION);
    const timer = window.setTimeout(() => setVisible(false), SUPPORT_NOTICE_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);

  if (!visible) return null;
  return (
    <div className="banner banner-support" role="status">
      <span>{t('support.notice')}</span>
      <a
        className="banner-support-link"
        href={SUPPORT_URL}
        target="_blank"
        rel="noreferrer noopener"
        onClick={() => setVisible(false)}
      >
        {t('support.link')}
      </a>
      <button className="link-button banner-support-dismiss" onClick={() => setVisible(false)}>
        {t('support.dismiss')}
      </button>
    </div>
  );
}
