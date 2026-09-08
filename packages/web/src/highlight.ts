/**
 * Resaltado de sintaxis para la previsualizacion de archivos.
 *
 * Se importa `highlight.js/lib/core` y se registran los lenguajes a mano, en
 * vez del paquete completo. El paquete completo trae ~190 gramaticas y pesa mas
 * que toda la aplicacion junta; esta lista cubre lo que aparece en un proyecto
 * real. Lo que no este registrado se muestra en texto plano, que para un panel
 * de consulta es un resultado perfectamente aceptable.
 *
 * La lista tiene que seguir a `LANGUAGE_BY_EXTENSION` del servidor: es el
 * servidor el que deduce el lenguaje de la extension y manda el nombre.
 */

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES: Readonly<Record<string, Parameters<typeof hljs.registerLanguage>[1]>> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  makefile,
  markdown,
  php,
  powershell,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

for (const [name, language] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, language);
}

/**
 * Devuelve HTML ya escapado por highlight.js, o null si no hay gramatica.
 *
 * Que devuelva null y no el texto plano es a proposito: quien llama tiene que
 * decidir explicitamente que hacer sin resaltado, y asi no hay forma de
 * terminar metiendo texto sin escapar en un `dangerouslySetInnerHTML`.
 */
export function highlightCode(text: string, language: string | null): string | null {
  if (language === null || !hljs.getLanguage(language)) return null;
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
