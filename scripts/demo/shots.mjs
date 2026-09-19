/**
 * `pnpm demo:shots`: las capturas del README, contra los datos de demo y con
 * el Chrome instalado en la maquina (Playwright no descarga ningun navegador).
 * Necesita un `pnpm build` previo: se capturan en modo produccion para que no
 * aparezca nada del entorno de desarrollo.
 *
 * Sin opciones saca las del README, con la interfaz en ingles, y las escribe en
 * `assets/captura-*.png`. Con `--lang <codigo>` —el nombre de uno de los archivos
 * de `packages/web/src/i18n/locales/`— saca las mismas en ese idioma y las deja
 * en la carpeta temporal (`agent-workbench-shots/<codigo>/`): sirven para
 * revisar como queda cada traduccion sin tocar las del README (hito 34).
 *
 * La app abre en el idioma del navegador (§6.23), asi que alcanza con darle al
 * contexto ese idioma. Los botones se buscan por el texto que muestran, leido
 * del mismo archivo de idioma que usa la app.
 *
 * Con `--dev` la interfaz la sirve Vite, sin compilar. Se ve igual, y no hace
 * falta `pnpm build`, que reescribe el `packages/web/dist` que esta sirviendo
 * una instancia abierta con `pnpm start`.
 *
 * Van en orden, porque algunas escriben: la memoria se instala de verdad en
 * online-store (despues de las de git, que la veria) y la copia propia se
 * activa en la carpeta de configuracion de la demo antes del buscador. Todo en
 * la carpeta temporal de la demo, que se regenera en cada corrida.
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { repoRoot, startDemoServer } from './environment.mjs';
import { assertDemoHistory, assertOnlySimulatedAgents } from './isolation.mjs';

const LOCALES_DIR = path.join(repoRoot, 'packages', 'web', 'src', 'i18n', 'locales');

/** El idioma que se le da al navegador para cada archivo; sin entrada, el codigo tal cual. */
const BROWSER_LOCALES = {
  en: 'en-US',
  es: 'es-PE',
  'zh-CN': 'zh-CN',
  ja: 'ja-JP',
  'pt-BR': 'pt-BR',
  ru: 'ru-RU',
  ko: 'ko-KR',
  fr: 'fr-FR',
  de: 'de-DE',
};

function languageFromArgs(argv) {
  const at = argv.findIndex((arg) => arg === '--lang' || arg.startsWith('--lang='));
  if (at === -1) return 'en';
  const value = argv[at].startsWith('--lang=') ? argv[at].slice('--lang='.length) : argv[at + 1];
  const available = readdirSync(LOCALES_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length));
  if (value === undefined || !available.includes(value)) {
    throw new Error(`--lang takes one of: ${available.join(', ')}`);
  }
  return value;
}

const args = process.argv.slice(2);
const language = languageFromArgs(args);
const mode = args.includes('--dev') ? 'dev' : 'prod';
const readLocale = (code) => JSON.parse(readFileSync(path.join(LOCALES_DIR, `${code}.json`), 'utf8'));
const english = readLocale('en');
const dictionary = language === 'en' ? english : readLocale(language);

/** El texto que muestra la app para una clave: el del idioma o, si falta, el ingles. */
function ui(key) {
  const value = dictionary[key] ?? english[key];
  if (value === undefined) throw new Error(`The key ${key} is not in en.json: update scripts/demo/shots.mjs.`);
  return value;
}

/** Una expresion que casa con el texto entero, sin que sus signos cuenten como expresion. */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = (text) => new RegExp(`^${escapeRegExp(text)}$`);

const outDir = language === 'en' ? path.join(repoRoot, 'assets') : path.join(tmpdir(), 'agent-workbench-shots', language);
mkdirSync(outDir, { recursive: true });

const { url, availableAgents, historyLines, demo, stop } = await startDemoServer({ mode, openBrowser: false });

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
  throw new Error(`Couldn't open Google Chrome: ${error.message}\nInstall it, or run "pnpm exec playwright install chromium" and change the channel in scripts/demo/shots.mjs.`);
}

try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1.5,
    colorScheme: 'dark',
    locale: BROWSER_LOCALES[language] ?? language,
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

  // online-store desplegado en la barra lateral.
  await setExpanded('online-store', true);
  await page.locator('.session-item').nth(6).waitFor();

  // Por la etiqueta entera: en algun idioma una solapa podria contener el nombre de otra.
  const panelTab = (key) =>
    page.locator('.side-panel-tabs button', { has: page.locator('.side-panel-tab-label', { hasText: exactly(ui(key)) }) });
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
  await panelTab('panel.tab.files').click();
  await openCartDir();
  // Que el medidor y los combos hayan leido el archivo antes de capturar.
  await page.waitForFunction(() => document.body.innerText.includes('1M'), null, { timeout: 15_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, 'captura-conversacion.png') });

  // 2. Cambios: la lista recortada a lo que ocupa, y el diff de un archivo.
  await panelTab('panel.tab.git').click();
  await page.getByText(ui('git.group.untracked')).first().waitFor({ timeout: 15_000 });
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
  await panelTab('panel.tab.files').click();
  await openCartDir();
  await treeRow('CartProvider.tsx').click();
  await page.locator('.preview-code').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);
  await page.locator('section.side-panel').screenshot({ path: path.join(outDir, 'captura-archivos.png') });

  /*
    4. Las cuatro CLIs: la barra con proyectos de varias —cada sesion con su
    insignia— y el menu del `+` de un proyecto abierto. online-store se pliega
    para que entren los que mezclan CLIs.
  */
  await setExpanded('online-store', false);
  for (const name of ['sales-dashboard', 'inventory', 'invoicing-api', 'customer-portal']) await setExpanded(name, true);
  await page.locator('.session-item .agent-badge', { hasText: 'OC' }).first().waitFor({ timeout: 15_000 });
  await page.locator('.sidebar-scroll').evaluate((element) => element.scrollTo(0, 0));
  await projectRow('sales-dashboard').locator('.split-button-arrow').click();
  await page.locator('.agent-menu-item').nth(3).waitFor({ timeout: 5_000 });
  await page.waitForTimeout(300);
  const sidebarBox = await page.locator('.sidebar').boundingBox();
  const menuBox = await page.locator('.agent-menu').boundingBox();
  const lastProjectBox = await page.locator('.project', { has: projectRow('customer-portal') }).boundingBox();
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
    5. La memoria compartida, instalada de verdad en online-store con las dos
    notas de la memoria nativa de Claude Code que trae la demo.
  */
  await panelTab('panel.tab.memory').click();
  await page.locator('.memory-form button', { hasText: exactly(ui('memory.form.preview')) }).click();
  await page.locator('.memory-change-list').waitFor({ timeout: 15_000 });
  await page.locator('.memory-form .primary-button', { hasText: exactly(ui('memory.plan.install')) }).click();
  await page.locator('.plan-row', { hasText: 'Prices in dollars' }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await page.screenshot({
    path: path.join(outDir, 'captura-memoria.png'),
    clip: clipTo(await page.locator('.memory-global').boundingBox()),
  });

  /*
    6. Buscar en todo: la copia propia se mide y se activa desde su dialogo, y
    se busca una palabra que esta en conversaciones de las cuatro CLIs.
  */
  await page.locator('.sidebar-header').getByRole('button', { name: ui('vault.name'), exact: true }).click();
  await page.locator('.vault-modal').waitFor();
  await page.locator('.vault-modal button', { hasText: exactly(ui('vault.dialog.measure')) }).click();
  const activate = page.locator('.vault-modal .primary-button', { hasText: exactly(ui('vault.dialog.activate')) });
  await activate.waitFor({ timeout: 60_000 });
  await activate.click();
  await page.waitForFunction((on) => document.querySelector('.vault-state')?.textContent === on, ui('vault.state.on'), { timeout: 60_000 });
  await page.keyboard.press('Escape');
  await page.locator('.sidebar-search-mode-option', { hasText: exactly(ui('search.mode.conversations')) }).click({ timeout: 60_000 });
  await page.locator('.sidebar-filter').fill('pass');
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

  console.log(`\nScreenshots (${language}) written to ${outDir}`);
} finally {
  await browser.close();
  stop();
}
