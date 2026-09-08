import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
import '@xterm/xterm/css/xterm.css';

const container = document.getElementById('root');
if (container === null) throw new Error('Falta el contenedor #root.');

// A proposito sin StrictMode: en desarrollo duplica los efectos, y cada montaje
// del terminal abre un proceso de la CLI. Un doble arranque por cada recarga no
// vale lo que aporta.
createRoot(container).render(<App />);
