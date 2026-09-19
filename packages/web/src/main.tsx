import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initLocale } from './i18n/useLocale.js';
import './styles.css';
import '@xterm/xterm/css/xterm.css';

const container = document.getElementById('root');
if (container === null) throw new Error('Falta el contenedor #root.');
const root = createRoot(container);

// El idioma se carga antes de pintar nada (§6.23): una primera pantalla en
// inglés que salta al español es peor que unos milisegundos de espera. Sin
// `await` de nivel superior, que el destino de compilación de Vite no admite.
//
// A proposito sin StrictMode: en desarrollo duplica los efectos, y cada montaje
// del terminal abre un proceso de la CLI. Un doble arranque por cada recarga no
// vale lo que aporta.
void initLocale().then(() => root.render(<App />));
