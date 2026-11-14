import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import express from 'express';

export const NOT_FOUND_TEXT = 'Not found.\nNo encontrado.';

export const LOOKS_LIKE_FILE = /\.[a-zA-Z0-9]{1,8}$/;

/**
 * Sirve la interfaz ya compilada.
 *
 * Vite no se importa siquiera en este camino: en produccion no tiene por que
 * estar instalado.
 *
 * El `sendFile` del final es el fallback de una SPA, y **solo** se aplica a
 * rutas que no piden un archivo. Un fallback que atrapa todo es el error
 * clasico de esta configuracion: un asset que falta devuelve el HTML con
 * estado 200, el navegador intenta interpretar `<!doctype html>` como
 * JavaScript y el error que se ve es un `Unexpected token '<'` que no tiene
 * nada que ver con la causa. Pasa de verdad — con un fragmento cargado a
 * demanda, como el resaltador de sintaxis, basta con recompilar mientras
 * alguien tiene la pagina abierta.
 *
 * Se detecta por la extension del ultimo segmento: si la ruta pide un archivo
 * y `express.static` no lo encontro, no existe, y eso es un 404.
 */
export function mountBuiltUi(app: Express, webDist: string): () => Promise<void> {
  const indexHtml = path.join(webDist, 'index.html');
  if (!existsSync(indexHtml)) {
    throw new Error(
      `There's no compiled interface in ${webDist}.
Run "pnpm build" before "pnpm start", or use "pnpm dev".`,
    );
  }

  app.use(express.static(webDist, { index: false, maxAge: 0 }));
  app.get(/.*/, (request: Request, response: Response) => {
    if (LOOKS_LIKE_FILE.test(request.path)) {
      response.status(404).type('text/plain').send(NOT_FOUND_TEXT);
      return;
    }
    // Se pasa la raíz aparte para que Express/send resuelva una ruta relativa;
    // si se pasa absoluta, los segmentos del camino pueden evaluarse como dotfiles.
    response.sendFile('index.html', { root: webDist });
  });

  return () => Promise.resolve();
}
