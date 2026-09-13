/**
 * Chequeo del marcado en linea del hilo.
 *
 *   npx tsx scripts/check-inline-markup.mjs
 *
 * Cubre lo que no se ve a ojo: el orden de las alternativas —que una URL
 * dentro de `codigo` no se convierta, que el enlace de markdown le gane a la
 * URL que lleva adentro— y el recorte de lo que en realidad era de la frase y
 * no de la direccion.
 *
 * Importa el modulo de la interfaz: no tiene JSX justamente para esto.
 */

import { nextInlineToken, nextUrl, trimUrl } from '../../web/src/inline-markup.ts';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

/** Todos los tokens de un texto, como los recorre el renderizador. */
function tokenize(text) {
  const out = [];
  let rest = text;
  while (rest.length > 0) {
    const match = nextInlineToken(rest);
    if (match === null) {
      out.push({ kind: 'text', text: rest });
      break;
    }
    if (match.index > 0) out.push({ kind: 'text', text: rest.slice(0, match.index) });
    out.push(match.token);
    rest = rest.slice(match.index + match.length);
  }
  return out;
}

const links = (text) => tokenize(text).filter((token) => token.kind === 'link');
const firstLink = (text) => links(text)[0] ?? null;

// --- 1. URL desnuda: lo que motiva todo esto ---------------------------------
{
  const token = firstLink('mira https://github.com/foo/bar a ver');
  check('URL suelta -> enlace', token?.href === 'https://github.com/foo/bar', `dio ${token?.href}`);
  check('la etiqueta es la direccion', token?.label === token?.href);
}

// --- 2. La puntuacion es de la frase, no de la URL ---------------------------
check('punto final fuera', firstLink('ver https://x.dev/a.')?.href === 'https://x.dev/a');
check('coma final fuera', firstLink('https://x.dev/a, y despues')?.href === 'https://x.dev/a');
check(
  'dos puntos y punto y coma fuera',
  firstLink('leelo en https://x.dev/a;')?.href === 'https://x.dev/a',
);
check(
  'parentesis que no abrio, fuera',
  firstLink('(ver https://x.dev/a)')?.href === 'https://x.dev/a',
);
check(
  'parentesis balanceado, adentro',
  firstLink('https://es.wikipedia.org/wiki/Ruby_(lenguaje)')?.href ===
    'https://es.wikipedia.org/wiki/Ruby_(lenguaje)',
);
check('trimUrl no se come una ruta normal', trimUrl('https://x.dev/a/b') === 'https://x.dev/a/b');

// --- 3. El texto que sigue a la URL no se pierde -----------------------------
{
  const tokens = tokenize('ver https://x.dev/a. Y despues otra cosa');
  const tail = tokens[tokens.length - 1];
  check(
    'lo que sigue al enlace se conserva',
    tail?.kind === 'text' && tail.text === '. Y despues otra cosa',
    JSON.stringify(tail),
  );
}

// --- 4. Dos URLs en la misma linea -------------------------------------------
{
  const found = links('uno https://a.dev/1 y dos https://b.dev/2');
  check(
    'dos URLs -> dos enlaces',
    found.length === 2 && found[0].href === 'https://a.dev/1' && found[1].href === 'https://b.dev/2',
    `dio ${found.map((l) => l.href).join(', ')}`,
  );
}

// --- 5. El orden de las alternativas -----------------------------------------
{
  const tokens = tokenize('`https://x.dev/a`');
  check(
    'una URL dentro de codigo sigue siendo codigo',
    tokens.length === 1 && tokens[0].kind === 'code',
    JSON.stringify(tokens),
  );
}
{
  const token = firstLink('[el repo](https://github.com/foo)');
  check(
    'el enlace de markdown le gana a la URL que lleva adentro',
    token?.href === 'https://github.com/foo' && token?.label === 'el repo',
    JSON.stringify(token),
  );
}

// --- 6. Esquemas: solo lo navegable ------------------------------------------
{
  const tokens = tokenize('[x](javascript:alert(1))');
  check(
    'javascript: no se convierte en enlace',
    tokens.every((token) => token.kind !== 'link'),
    JSON.stringify(tokens),
  );
}
check('mailto: si', firstLink('[escribime](mailto:a@b.com)')?.href === 'mailto:a@b.com');
check('ftp:// no se autovincula', links('ftp://x.dev/a').length === 0);

// --- 7. Lo de siempre sigue andando ------------------------------------------
{
  const tokens = tokenize('esto es **fuerte** y esto *suave* y ~~esto no~~');
  const kinds = tokens.map((token) => token.kind).join(',');
  check(
    'negrita, cursiva y tachado',
    kinds === 'text,strong,text,em,text,del',
    kinds,
  );
}
check('texto sin marcado -> no hay token', nextInlineToken('nada que marcar aca') === null);

// --- 8. El texto del usuario: URLs si, markdown no --------------------------
//
// Lo que uno escribe se muestra tal cual —es texto, no un documento— pero los
// enlaces se tienen que poder abrir. `nextUrl` es el camino de ese texto, y es
// otro que el del markdown: encontro el bug de que los enlaces del asistente
// andaban y los propios no.
{
  const found = nextUrl('mira el ticket https://jira.local/AAA-1394 y decime');
  check(
    'nextUrl encuentra la URL de un mensaje propio',
    found?.href === 'https://jira.local/AAA-1394',
    JSON.stringify(found),
  );
  check('y dice donde empieza', found?.index === 15, String(found?.index));
  check('y cuanto consume, ya recortada', found?.length === 27, String(found?.length));
}
check('sin URL no hay nada que convertir', nextUrl('esto no es un enlace') === null);
check('el markdown del usuario no se toca', nextUrl('escribi **negrita** y punto') === null);
check(
  'el parentesis de la frase queda afuera',
  nextUrl('(ver https://x.dev/a) despues')?.href === 'https://x.dev/a',
);

console.log(failures === 0 ? '\nTodo bien.' : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
