/**
 * Conexion con el servidor local.
 *
 * Reconecta sola. Eso importa mas de lo que parece: desde el Hito 2 las pty
 * viven en el servidor y sobreviven a que se caiga el socket, asi que
 * reconectarse devuelve las sesiones intactas en vez de perderlas.
 *
 * No sabe nada de React a proposito: se puede probar y razonar aparte.
 */

import {
  REMOTE_REVOKED_CLOSE_CODE,
  TOKEN_QUERY_PARAM,
  WS_PATH,
  encodeClientMessage,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from '@agent-workbench/shared';
import { sessionToken } from './session-token.js';

/**
 * `revoked` (hito 37): esta ventana entro como equipo remoto y el anfitrion lo
 * revoco, o apago el acceso remoto. No se reintenta: la credencial ya no entra.
 */
export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'failed' | 'revoked';

type MessageHandler = (message: ServerMessage) => void;
type StatusHandler = (status: ConnectionStatus) => void;
/** Se dispara cuando la conexion vuelve tras haberse caido: hay que reenganchar. */
type ReopenHandler = () => void;

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;

export class AgentConnection {
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = 'connecting';
  private attempt = 0;
  private closedByUs = false;
  private hasConnectedOnce = false;
  private reconnectTimer: number | undefined;

  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly reopenHandlers = new Set<ReopenHandler>();

  /** Cola de mensajes escritos mientras el socket estaba caido. */
  private readonly outbox: ClientMessage[] = [];

  getStatus(): ConnectionStatus {
    return this.status;
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  onReopen(handler: ReopenHandler): () => void {
    this.reopenHandlers.add(handler);
    return () => this.reopenHandlers.delete(handler);
  }

  connect(): void {
    if (this.socket !== null) return;

    const url = new URL(WS_PATH, window.location.href);
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Sin token en la URL —el caso de una recarga— la cookie de sesion
    // autentica igual. Si tampoco vale, el servidor rechaza el upgrade y lo
    // tratamos como fallo de conexion.
    if (sessionToken !== null) url.searchParams.set(TOKEN_QUERY_PARAM, sessionToken);

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus('open');

      // Lo que se intento mandar mientras estaba caido sale ahora.
      while (this.outbox.length > 0) {
        const queued = this.outbox.shift();
        if (queued !== undefined) socket.send(encodeClientMessage(queued));
      }

      // Solo avisamos de "reenganchar" si esto es una reconexion, no la
      // primera conexion: al abrir por primera vez no hay nada que reenganchar.
      if (this.hasConnectedOnce) {
        for (const handler of this.reopenHandlers) handler();
      }
      this.hasConnectedOnce = true;
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      const message = parseServerMessage(event.data);
      if (message === null) {
        console.warn('[conexion] mensaje del servidor no reconocido');
        return;
      }
      for (const handler of this.messageHandlers) handler(message);
    };

    socket.onclose = (event: CloseEvent) => {
      this.socket = null;
      if (this.closedByUs) return;
      // El servidor cerro a proposito: reconectar seria chocar contra un 403 sin fin.
      if (event.code === REMOTE_REVOKED_CLOSE_CODE) {
        this.setStatus('revoked');
        return;
      }
      this.setStatus('reconnecting');
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // `close` llega siempre despues; la reconexion se maneja alli.
    };
  }

  send(message: ClientMessage): void {
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(encodeClientMessage(message));
      return;
    }
    // La salida del pty no se encola: se recupera con el replay al reenganchar.
    if (message.type !== 'input' && message.type !== 'resize') {
      this.outbox.push(message);
    }
  }

  close(): void {
    this.closedByUs = true;
    window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const handler of this.statusHandlers) handler(next);
  }

  private scheduleReconnect(): void {
    this.attempt += 1;

    // Si nunca llegamos a conectar, el problema no es una caida pasajera:
    // o falta el token o el servidor no esta. Reintentar para siempre solo
    // esconde el error.
    if (!this.hasConnectedOnce && this.attempt > 4) {
      this.setStatus('failed');
      return;
    }

    // Backoff exponencial con tope: si el servidor se cayo de verdad, no
    // martillamos el navegador con intentos.
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.attempt - 1), RECONNECT_MAX_MS);
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }
}
