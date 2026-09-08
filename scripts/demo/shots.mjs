/**
 * `pnpm demo:shots`: las capturas del README, contra los datos de demo y con
 * el Chrome instalado en la maquina (Playwright no descarga ningun navegador).
 * Escribe `docs/captura-*.png`. Necesita un `pnpm build` previo: se capturan
 * en modo produccion para que no aparezca nada del entorno de desarrollo.
 */
import path from 'node:path';
import { chromium } from 'playwright';
import { repoRoot, startDemoServer } from './environment.mjs';

const outDir = path.join(repoRoot, 'docs');
const { url, demo, stop } = await startDemoServer({ mode: 'prod', openBrowser: false });

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
} catch (error) {
  stop();
  throw new Error(`No se pudo abrir Google Chrome: ${error.message}\nInstalalo, o corre "pnpm exec playwright install chromium" y cambia el canal en scripts/demo/shots.mjs.`);
}

try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1.5,
    colorScheme: 'dark',
    locale: 'es-PE',
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error('pageerror:', error.message));

  await page.goto(url);
  // Las tres pestanas de workspace.json y los seis proyectos de la barra.
  await page.locator('.tab').nth(demo.tabs.length - 1).waitFor({ timeout: 30_000 });
  await page.locator('.project-row').nth(5).waitFor({ timeout: 30_000 });

  // La pestana principal, con su conversacion cargada. Los turnos dentro de una
  // tanda plegada no son visibles, asi que se espera a que esten en el DOM.
  await page.locator('.tab', { hasText: demo.tabs[0].label }).click();
  await page.locator('.turn').nth(8).waitFor({ state: 'attached', timeout: 30_000 });

  // tienda-online desplegado en la barra lateral.
  const tiendaRow = page.locator('.project-row', {
    has: page.locator('.project-name', { hasText: /^tienda-online$/ }),
  });
  await tiendaRow.locator('.project-toggle').click();
  await page.locator('.session-item').nth(6).waitFor();

  const panelTab = (label) => page.locator('.side-panel-tabs button', { hasText: label });
  const treeRow = (name) =>
    page.locator('.tree-row', { has: page.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }) });
  const openCartDir = async () => {
    await treeRow('src').waitFor();
    if ((await treeRow('cart').count()) === 0) await treeRow('src').click();
    await treeRow('cart').waitFor();
    if ((await treeRow('CartProvider.tsx').count()) === 0) await treeRow('cart').click();
    await treeRow('CartProvider.tsx').waitFor();
  };

  // 1. Vista completa: conversacion, barra lateral y arbol con src/cart abierto.
  await panelTab('Archivos').click();
  await openCartDir();
  // Que el medidor y los combos hayan leido el archivo antes de capturar.
  await page.waitForFunction(() => document.body.innerText.includes('1M'), null, { timeout: 15_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, 'captura-conversacion.png') });

  // 2. Cambios: la lista recortada a lo que ocupa, y el diff de un archivo.
  await panelTab('Cambios').click();
  await page.getByText('Sin seguimiento').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);
  const panelBox = await page.locator('section.side-panel').boundingBox();
  const clipTo = (bottomBox) => ({
    x: panelBox.x,
    y: panelBox.y,
    width: panelBox.width,
    height: bottomBox.y + bottomBox.height + 24 - panelBox.y,
  });
  await page.screenshot({
    path: path.join(outDir, 'captura-cambios.png'),
    clip: clipTo(await page.locator('.git-list').last().boundingBox()),
  });
  await page.locator('.git-item', { hasText: 'CartProvider.tsx' }).click();
  await page.locator('.diff-line').nth(3).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(outDir, 'captura-diff.png'),
    clip: clipTo(await page.locator('.diff-line').last().boundingBox()),
  });

  // 3. Un archivo previsualizado. El arbol vuelve plegado al cambiar de solapa.
  await panelTab('Archivos').click();
  await openCartDir();
  await treeRow('CartProvider.tsx').click();
  await page.locator('.preview-code').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);
  await page.locator('section.side-panel').screenshot({ path: path.join(outDir, 'captura-archivos.png') });

  console.log(`\nCapturas escritas en ${outDir}`);
} finally {
  await browser.close();
  stop();
}
