/**
 * Una terminal enganchada a una pty del servidor.
 *
 * REGLA DURA: aca no se registra ni un solo manejador de teclado propio.
 * Todo lo que teclea el usuario sale por `onData` de xterm y va al pty sin
 * tocar. Es lo unico que garantiza que Esc, Esc Esc, Ctrl+C, Ctrl+R, Ctrl+O,
 * Shift+Tab, las flechas y Alt+V lleguen intactos a la CLI. Los atajos propios
 * de la app viven fuera de este componente. El dedo si tiene manejo propio
 * (§6.25): se convierte en la rueda del mouse, y lo demas lo decide xterm.
 *
 * Este componente NO es duenio del proceso: se engancha a una terminal que ya
 * existe en el servidor y se desengancha al desmontarse. Si el socket se cae y
 * vuelve, se reengancha y repinta con el replay.
 */

import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import type { TerminalId } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import { t } from './i18n/index.js';
import { isDrag, momentumStep, releaseVelocity, wholePixels, type TouchSample } from './touch-scroll.js';

/** Espera a que el contenedor deje de cambiar de tamano antes de avisar al pty. */
const RESIZE_DEBOUNCE_MS = 60;

/**
 * Renderer del terminal.
 *
 * El default es canvas y no webgl, contra lo que sugiere el brief. Motivo
 * medido en Windows 11 + Chrome, la plataforma principal: con `WebglAddon` el
 * terminal queda en blanco aunque los datos lleguen, y el renderer del
 * navegador deja de responder. Se probo tambien cargando el addon despues del
 * primer fit, por si el problema era una textura de tamano cero: se cuelga
 * igual.
 *
 * Un renderer acelerado que congela la pestana es peor que uno mas lento, asi
 * que WebGL queda opt-in con ?renderer=webgl.
 */
function preferredRenderer(): 'webgl' | 'canvas' {
  return new URLSearchParams(window.location.search).get('renderer') === 'webgl'
    ? 'webgl'
    : 'canvas';
}

/**
 * Tema del terminal.
 *
 * Va aparte de la hoja de estilos porque xterm pinta sobre un canvas y no lee
 * variables CSS: hay que darle los colores en un objeto. Los valores siguen a
 * los de `styles.css` a mano; si se cambian alla, se cambian aca.
 *
 * Solo se fijan el fondo, el texto, el cursor y la seleccion. La paleta de 16
 * colores ANSI se deja en la que trae xterm: la CLI la usa para su propia
 * salida y redefinirla seria decidir por ella como se ve.
 */
const TERMINAL_THEMES = {
  dark: {
    background: '#12141a',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    selectionBackground: '#2f3542',
  },
  light: {
    background: '#fbfbfd',
    foreground: '#22262e',
    cursor: '#22262e',
    selectionBackground: '#cfd8e3',
  },
} as const;

interface TerminalViewProps {
  terminalId: TerminalId;
  connection: AgentConnection;
  /** Solo la pestana activa se ve; las demas quedan montadas pero ocultas. */
  active: boolean;
  theme: 'light' | 'dark';
  /**
   * Si al activarse se lleva el foco del teclado. La consola del panel derecho
   * dice que no: esta siempre activa, y con el default se robaria el foco de la
   * pestana del agente en cada recarga de la pagina.
   */
  autoFocus?: boolean;
}

export function TerminalView({
  terminalId,
  connection,
  active,
  theme,
  autoFocus = true,
}: TerminalViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // El tema entra por un ref para que cambiarlo no vuelva a correr el efecto de
  // montaje: recrear el terminal perderia la pantalla y reabriria el attach.
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", "Consolas", "Menlo", "DejaVu Sans Mono", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      scrollback: 10_000,
      allowProposedApi: true,
      theme: TERMINAL_THEMES[themeRef.current],
    });
    terminalRef.current = terminal;

    const fitAddon = new FitAddon();
    fitRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(container);

    let webglAttempted = false;
    const enableWebglRenderer = (): void => {
      if (webglAttempted || preferredRenderer() !== 'webgl') return;
      webglAttempted = true;
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        terminal.loadAddon(webgl);
      } catch {
        console.info('[terminal] WebGL no disponible; se usa el renderer por defecto.');
      }
    };

    let lastSize = { cols: 0, rows: 0 };
    let resizeTimer: number | undefined;

    /**
     * true si el contenedor tiene caja.
     *
     * Desde que la terminal vive en la columna derecha esto **no** es una
     * comprobacion defensiva de arranque: con la solapa CLI detras de Cambios o
     * Archivos el contenedor mide 0x0 todo el tiempo que dure la visita. Un
     * `fit()` sobre una caja vacia deja el terminal en una o dos columnas, y
     * ese tamano se le reenvia al pty: la CLI se redibuja rota y no se recupera
     * sola. Mientras no haya caja no se mide ni se avisa nada, y el proceso
     * conserva el ultimo tamano bueno.
     */
    const hasBox = (): boolean => container.clientWidth > 0 && container.clientHeight > 0;

    const sendResize = (force: boolean): void => {
      const { cols, rows } = terminal;
      if (cols <= 0 || rows <= 0) return;
      if (!force && cols === lastSize.cols && rows === lastSize.rows) return;
      lastSize = { cols, rows };
      connection.send({ type: 'resize', terminalId, cols, rows });
    };

    /*
      Un cambio de tamano no te saca de donde estabas (§5.6). Medido en el
      emulador con la app de Android, 25-09-2026:

      - La vista que no se ve queda sin tamano, y el navegador pone en 0 la
        barra de scroll de xterm sin que xterm se entere: al volver, la barra
        decia "arriba" y el texto "abajo", y el primer toque saltaba al
        principio del historial. En la PC pasaba igual al volver a la solapa
        CLI desde Cambios o Archivos.
      - Al cerrarse el teclado del telefono la terminal crece (17 a 33 filas), y
        xterm quedaba 16 lineas arriba del final, sin seguir la salida nueva:
        habia que escribir algo para que bajara.

      Mientras la caja cambia no se anota nada, porque la posicion que xterm
      cree tener en ese rato es la rota. Despues del fit se vuelve: al final si
      estaba al final, o a la misma linea si uno habia subido a leer.
    */
    let seen = { atBottom: true, line: 0 };
    let resizing = false;
    const rememberPosition = (): void => {
      if (resizing || !hasBox()) return;
      const buffer = terminal.buffer.active;
      seen = { atBottom: buffer.viewportY >= buffer.baseY, line: buffer.viewportY };
    };
    const restorePosition = (): void => {
      const buffer = terminal.buffer.active;
      if (buffer.baseY === 0) return;
      const target = seen.atBottom ? buffer.baseY : Math.min(seen.line, buffer.baseY);
      // Ida y vuelta de una linea: moverse obliga a xterm a volver a poner su
      // barra donde va, que es lo que el navegador le desacomodo.
      terminal.scrollToLine(target > 0 ? target - 1 : target + 1);
      terminal.scrollToLine(target);
    };
    // Lo que desplaza el usuario no pasa por `onScroll`, pero se pinta.
    const renderSubscription = terminal.onRender(rememberPosition);
    const scrollSubscription = terminal.onScroll(rememberPosition);
    let boxShown = hasBox();

    const fitAndReport = (): void => {
      if (!hasBox()) return;
      try {
        fitAddon.fit();
      } catch {
        // El contenedor todavia no tiene tamano. El siguiente evento reintenta.
        return;
      }
      if (resizing) {
        restorePosition();
        resizing = false;
      }
      if (terminal.cols > 0 && terminal.rows > 0) enableWebglRenderer();
      sendResize(false);
    };

    const scheduleFit = (): void => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(fitAndReport, RESIZE_DEBOUNCE_MS);
    };

    const resizeObserver = new ResizeObserver(() => {
      const shown = hasBox();
      resizing = true;
      // Al reaparecer, tambien en el acto: que no se pinte el principio del historial hasta el fit.
      if (shown && !boxShown) restorePosition();
      boxShown = shown;
      scheduleFit();
    });
    resizeObserver.observe(container);
    window.addEventListener('resize', scheduleFit);

    /*
      Deslizar el dedo (§6.25): lo mismo que la rueda del mouse en la PC. El
      manejo propio de xterm movia el historial 1 a 1 y se paraba en seco al
      soltar (con miles de lineas, leer para atras era casi no moverse), y con
      una CLI a pantalla completa, o que pidio el mouse, no hacia nada. Cada
      movimiento va como una rueda a la terminal y xterm decide que es: su
      historial, flechas o la rueda de la CLI. Al soltar rapido sigue un rato,
      frenandose (`touch-scroll.ts`). Un toque sin arrastrar no se toca: sigue
      siendo el clic que enfoca la terminal y abre el teclado.

      Los oyentes van en captura sobre el contenedor: xterm escucha el dedo en
      su elemento, adentro, y no tiene que enterarse, o desplazaria dos veces.
    */
    let drag: {
      id: number;
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      moving: boolean;
      samples: TouchSample[];
    } | null = null;
    let momentumFrame = 0;
    let pendingPixels = 0;

    const scrollByPixels = (amount: number, clientX: number, clientY: number): void => {
      const target = terminal.element;
      if (target === undefined) return;
      const whole = wholePixels(pendingPixels + amount);
      pendingPixels = whole.rest;
      if (whole.pixels === 0) return;
      target.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: whole.pixels,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          clientX,
          clientY,
          bubbles: true,
          cancelable: true,
        }),
      );
    };

    const stopMomentum = (): void => {
      window.cancelAnimationFrame(momentumFrame);
      momentumFrame = 0;
    };

    const startMomentum = (velocity: number, clientX: number, clientY: number): void => {
      let current = velocity;
      let last = performance.now();
      const frame = (now: number): void => {
        if (!hasBox()) {
          momentumFrame = 0;
          return;
        }
        const step = momentumStep(current, now - last);
        last = now;
        scrollByPixels(step.delta, clientX, clientY);
        current = step.velocity;
        momentumFrame = current === 0 ? 0 : window.requestAnimationFrame(frame);
      };
      momentumFrame = window.requestAnimationFrame(frame);
    };

    const touchById = (list: TouchList, id: number): Touch | null => {
      for (let index = 0; index < list.length; index++) {
        const touch = list.item(index);
        if (touch !== null && touch.identifier === id) return touch;
      }
      return null;
    };

    const onTouchStart = (event: TouchEvent): void => {
      stopMomentum();
      pendingPixels = 0;
      const touch = event.touches.length === 1 ? event.touches.item(0) : null;
      drag =
        touch === null
          ? null
          : {
              id: touch.identifier,
              startX: touch.clientX,
              startY: touch.clientY,
              lastX: touch.clientX,
              lastY: touch.clientY,
              moving: false,
              samples: [{ t: event.timeStamp, y: touch.clientY }],
            };
    };

    const onTouchMove = (event: TouchEvent): void => {
      event.stopPropagation();
      if (drag === null) return;
      const touch = touchById(event.touches, drag.id);
      if (touch === null) return;
      if (!drag.moving) {
        if (!isDrag(touch.clientX - drag.startX, touch.clientY - drag.startY)) return;
        drag.moving = true;
      }
      if (event.cancelable) event.preventDefault();
      const delta = drag.lastY - touch.clientY;
      drag.lastX = touch.clientX;
      drag.lastY = touch.clientY;
      drag.samples.push({ t: event.timeStamp, y: touch.clientY });
      if (drag.samples.length > 32) drag.samples.shift();
      scrollByPixels(delta, touch.clientX, touch.clientY);
    };

    const onTouchEnd = (event: TouchEvent): void => {
      if (drag === null || touchById(event.changedTouches, drag.id) === null) return;
      const ended = drag;
      drag = null;
      if (!ended.moving) return;
      const velocity = releaseVelocity(ended.samples, event.timeStamp);
      if (velocity !== 0) startMomentum(velocity, ended.lastX, ended.lastY);
    };

    const onTouchCancel = (): void => {
      drag = null;
    };

    container.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    container.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    container.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
    container.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true });

    /*
      Dos pantallas mirando la misma pestana (hito 37): esta ventana y la del
      otro equipo, de otro tamano. La pty tiene **un** tamano, y el servidor se
      queda con el ultimo que le mandaron; una ventana solo lo manda cuando su
      caja cambia, asi que al volver a esta despues de usar la otra, la CLI
      seguia dibujada para aquella hasta que alguien movia un divisor.

      Al recuperar el foco, o al volver a estar a la vista, la terminal que se
      ve reclama su tamano aunque para ella no haya cambiado (`force`). La que
      nadie mira queda desacomodada, y se acomoda sola cuando le toque. Con una
      sola ventana es un `resize` con el mismo tamano, como el que ya manda
      activar una pestana.
    */
    const reclaimSize = (): void => {
      if (document.visibilityState !== 'visible' || !hasBox()) return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      sendResize(true);
    };
    window.addEventListener('focus', reclaimSize);
    document.addEventListener('visibilitychange', reclaimSize);

    // Teclas del usuario -> pty. Sin filtro, sin excepciones.
    const dataSubscription = terminal.onData((data) => {
      connection.send({ type: 'input', terminalId, data });
    });

    const offMessage = connection.onMessage((message) => {
      switch (message.type) {
        case 'terminal.output':
          if (message.terminalId === terminalId) terminal.write(message.data);
          break;
        case 'terminal.replay':
          if (message.terminalId !== terminalId) break;
          // El replay es el estado completo que conoce el servidor, no un
          // incremento: hay que limpiar antes de escribirlo.
          terminal.reset();
          if (message.truncated) {
            terminal.write(`\x1b[90m-- ${t('terminal.replayTruncated')} --\x1b[0m\r\n`);
          }
          terminal.write(message.data);
          break;
        case 'terminal.exit':
          if (message.terminalId !== terminalId) break;
          terminal.write(
            `\r\n\x1b[90m-- ${t('terminal.exited', { code: message.exitCode })} --\x1b[0m\r\n`,
          );
          break;
        default:
          break;
      }
    });

    /** Pide el buffer y sincroniza el tamano. Corre al montar y al reconectar. */
    const attach = (): void => {
      if (hasBox()) {
        try {
          fitAddon.fit();
        } catch {
          // Sin tamano todavia; el ResizeObserver reintenta enseguida.
        }
      }
      const cols = terminal.cols > 0 ? terminal.cols : 80;
      const rows = terminal.rows > 0 ? terminal.rows : 24;
      lastSize = { cols, rows };
      connection.send({ type: 'terminal.attach', terminalId, cols, rows });
    };

    attach();
    const offReopen = connection.onReopen(attach);

    return () => {
      window.clearTimeout(resizeTimer);
      window.removeEventListener('resize', scheduleFit);
      window.removeEventListener('focus', reclaimSize);
      document.removeEventListener('visibilitychange', reclaimSize);
      resizeObserver.disconnect();
      stopMomentum();
      container.removeEventListener('touchstart', onTouchStart, { capture: true });
      container.removeEventListener('touchmove', onTouchMove, { capture: true });
      container.removeEventListener('touchend', onTouchEnd, { capture: true });
      container.removeEventListener('touchcancel', onTouchCancel, { capture: true });
      renderSubscription.dispose();
      scrollSubscription.dispose();
      dataSubscription.dispose();
      offMessage();
      offReopen();
      // Desenganchar no mata el proceso: la pty sigue viva en el servidor.
      connection.send({ type: 'terminal.detach', terminalId });
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId, connection]);

  // Cambiar de tema repinta el terminal en el lugar, sin recrearlo.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal === null) return;
    terminal.options.theme = TERMINAL_THEMES[theme];
  }, [theme]);

  // Al volver a una pestana hay que remedir: mientras estuvo oculta el
  // contenedor pudo cambiar de tamano sin que xterm se enterara.
  useEffect(() => {
    if (!active) return;
    const terminal = terminalRef.current;
    const fitAddon = fitRef.current;
    if (terminal === null || fitAddon === null) return;

    const timer = window.setTimeout(() => {
      // Mismo motivo que `hasBox()`: activar una pestana cuya solapa no esta
      // delante no puede terminar en un resize contra una caja vacia.
      const container = containerRef.current;
      if (container === null || container.clientWidth === 0 || container.clientHeight === 0) {
        return;
      }
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      if (autoFocus) terminal.focus();
      if (terminal.cols > 0 && terminal.rows > 0) {
        connection.send({
          type: 'resize',
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        });
      }
    }, 0);

    return () => window.clearTimeout(timer);
  }, [active, autoFocus, terminalId, connection]);

  return (
    <div
      className={`terminal-surface${active ? '' : ' terminal-surface-hidden'}`}
      ref={containerRef}
    />
  );
}
