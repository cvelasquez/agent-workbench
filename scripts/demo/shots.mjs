/**
 * `pnpm demo:shots`: las capturas del README, contra los datos de demo y con
 * el Chrome instalado en la maquina (Playwright no descarga ningun navegador).
 * Escribe `docs/captura-*.png`. Necesita un `pnpm build` previo: se capturan
 * en modo produccion para que no aparezca nada del entorno de desarrollo.
 *
 * Van en orden, porque algunas escriben: la memoria se instala de verdad en
 * tienda-online (despues de las de git, que la veria) y la copia propia se
 * activa en la carpeta de configuracion de la demo antes del buscador. Todo en
 * la carpeta temporal de la demo, que se regenera en cada corrida.
 */
import path from 'node:path';
import { chromium } from 'playwright';
import { repoRoot, startDemoServer } from './environment.mjs';
import { assertDemoHistory, assertOnlySimulatedAgents } from './isolation.mjs';

const outDir = path.join(repoRoot, 'docs');
const { url, availableAgents, historyLines, demo, stop } = await startDemoServer({ mode: 'prod', openBrowser: false });

/*
  Segunda red, despues del PATH filtrado de `isolation.mjs`: el servidor tiene
  que haber visto exactamente las cuatro CLIs simuladas —una de verdad saldria
  con su version, una que falta dejaria el menu incompleto— y ningun historial
  fuera del home de la demo: el de OpenCode se lee aunque su CLI no este
  (hito 26).
*/
try {
  assertOnlySimulatedAgents(availableAgents);
  assertDemoHistory(historyLines, demo.homeView);
} catch (error) {
  stop();
  throw error;
}

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
  // Las cuatro pestanas de workspace.json y los seis proyectos de la barra.
  await page.locator('.tab').nth(demo.tabs.length - 1).waitFor({ timeout: 30_000 });
  await page.locator('.project-row').nth(5).waitFor({ timeout: 30_000 });

  // La pestana principal, con su conversacion cargada. Los turnos dentro de una
  // tanda plegada no son visibles, asi que se espera a que esten en el DOM.
  await page.locator('.tab', { hasText: demo.tabs[0].label }).click();
  await page.locator('.turn').nth(8).waitFor({ state: 'attached', timeout: 30_000 });

  const projectRow = (name) =>
    page.locator('.project-row', { has: page.locator('.project-name', { hasText: new RegExp(`^${name}$`) }) });
  const setExpanded = async (name, open) => {
    const row = projectRow(name);
    const isOpen = (await row.locator('.chevron-open').count()) > 0;
    if (isOpen !== open) await row.locator('.project-toggle').click();
  };

  // tienda-online desplegado en la barra lateral.
  await setExpanded('tienda-online', true);
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

  /*
    4. Las cuatro CLIs: la barra con proyectos de varias —cada sesion con su
    insignia— y el menu del `+` de un proyecto abierto. tienda-online se pliega
    para que entren los que mezclan CLIs.
  */
  await setExpanded('tienda-online', false);
  for (const name of ['dashboard-ventas', 'inventario', 'api-facturacion', 'portal-clientes']) await setExpanded(name, true);
  await page.locator('.session-item .agent-badge', { hasText: 'OC' }).first().waitFor({ timeout: 15_000 });
  await page.locator('.sidebar-scroll').evaluate((element) => element.scrollTo(0, 0));
  await projectRow('dashboard-ventas').locator('.split-button-arrow').click();
  await page.locator('.agent-menu-item').nth(3).waitFor({ timeout: 5_000 });
  await page.waitForTimeout(300);
  const sidebarBox = await page.locator('.sidebar').boundingBox();
  const menuBox = await page.locator('.agent-menu').boundingBox();
  const lastProjectBox = await page.locator('.project', { has: projectRow('portal-clientes') }).boundingBox();
  await page.screenshot({
    path: path.join(outDir, 'captura-clis.png'),
    clip: {
      x: 0,
      y: 0,
      width: Math.max(sidebarBox.x + sidebarBox.width, menuBox.x + menuBox.width) + 16,
      height: Math.min(sidebarBox.y + sidebarBox.height, lastProjectBox.y + lastProjectBox.height),
    },
  });
  await page.keyboard.press('Escape');
  await page.locator('.agent-menu').waitFor({ state: 'detached', timeout: 5_000 });

  /*
    5. La memoria compartida, instalada de verdad en tienda-online con las dos
    notas de la memoria nativa de Claude Code que trae la demo.
  */
  await panelTab('Memoria').click();
  await page.locator('.memory-form button', { hasText: 'Ver cambios' }).click();
  await page.locator('.memory-change-list').waitFor({ timeout: 15_000 });
  await page.locator('.memory-form .primary-button', { hasText: 'Instalar' }).click();
  await page.locator('.plan-row', { hasText: 'Precios en soles' }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await page.screenshot({
    path: path.join(outDir, 'captura-memoria.png'),
    clip: clipTo(await page.locator('.memory-global').boundingBox()),
  });

  /*
    6. Buscar en todo: la copia propia se mide y se activa desde su dialogo, y
    se busca una palabra que esta en conversaciones de las cuatro CLIs.
  */
  await page.locator('.sidebar-header button[aria-label="Copia propia"]').click();
  await page.locator('.vault-modal').waitFor();
  await page.locator('.vault-modal button', { hasText: /^Medir$/ }).click();
  await page.locator('.vault-modal .primary-button', { hasText: 'Activar' }).waitFor({ timeout: 60_000 });
  await page.locator('.vault-modal .primary-button', { hasText: 'Activar' }).click();
  await page.waitForFunction(() => document.querySelector('.vault-state')?.textContent === 'Encendida', null, { timeout: 60_000 });
  await page.keyboard.press('Escape');
  await page.locator('.sidebar-search-mode-option', { hasText: 'En conversaciones' }).click({ timeout: 60_000 });
  await page.locator('.sidebar-filter').fill('pasan');
  await page.locator('.sidebar-filter').press('Enter');
  for (const badge of ['CC', 'CX', 'OC', 'AG']) {
    await page.locator('.search-group-title .agent-badge', { hasText: badge }).first().waitFor({ timeout: 30_000 });
  }
  await page.waitForTimeout(800);
  const searchSidebar = await page.locator('.sidebar').boundingBox();
  const resultsBox = await page.locator('.search-results').boundingBox();
  await page.screenshot({
    path: path.join(outDir, 'captura-buscador.png'),
    clip: {
      x: searchSidebar.x,
      y: searchSidebar.y,
      width: searchSidebar.width,
      height: Math.min(searchSidebar.height, resultsBox.y + resultsBox.height + 16 - searchSidebar.y),
    },
  });

  console.log(`\nCapturas escritas en ${outDir}`);
} finally {
  await browser.close();
  stop();
}
