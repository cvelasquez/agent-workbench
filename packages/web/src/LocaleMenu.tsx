/**
 * El botón de idioma de la cabecera, al lado del tema (§6.23).
 *
 * Muestra el código del idioma (`ES`, `EN`…) y abre un menú con "Automático" y
 * cada idioma escrito en su propia lengua, que es como uno lo busca en una
 * lista. Cada nombre lleva su `lang`, para que el navegador lo dibuje con la
 * tipografía de ese idioma.
 */

import { useCallback, useRef, useState } from 'react';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { LOCALES, LOCALE_BADGES, LOCALE_NAMES, t } from './i18n/index.js';
import { browserLocale, changeLocalePreference, useLocale, useLocalePreference } from './i18n/useLocale.js';

export function LocaleMenu(): JSX.Element {
  const locale = useLocale();
  const preference = useLocalePreference();
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const choose = (next: typeof preference): void => {
    // Si el archivo del idioma no llega, la app sigue como estaba: no hay nada
    // que avisar más allá de que el menú no cambió nada.
    void changeLocalePreference(next).catch(() => undefined);
  };

  const items: ContextMenuItem[] = [
    {
      label: t('header.locale.auto', { name: LOCALE_NAMES[browserLocale()] }),
      checked: preference === 'auto',
      onSelect: () => choose('auto'),
    },
    ...LOCALES.map((code) => ({
      label: LOCALE_NAMES[code],
      lang: code,
      checked: preference === code,
      onSelect: () => choose(code),
    })),
  ];

  const name = LOCALE_NAMES[locale];
  return (
    <>
      <button
        ref={buttonRef}
        className="icon-button locale-button"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor((current) => (current === null ? { x: rect.left, y: rect.bottom + 4 } : null));
        }}
        title={preference === 'auto' ? t('header.locale.titleAuto', { name }) : t('header.locale.title', { name })}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
      >
        {LOCALE_BADGES[locale]}
      </button>
      {anchor !== null && (
        <ContextMenu x={anchor.x} y={anchor.y} items={items} onClose={close} anchor={buttonRef.current} />
      )}
    </>
  );
}
