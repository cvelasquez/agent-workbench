/**
 * Sigue la conversacion de la pestana activa.
 *
 * Se suscribe a una sola pestana a la vez: la que se esta mirando. Seguir todas
 * significaria tener un lector de archivo abierto por pestana para paneles que
 * nadie tiene delante.
 *
 * La suscripcion se rehace al reconectar. Sin eso, un `F5` o una caida del
 * socket dejarian el panel congelado mostrando una conversacion que sigue
 * avanzando en el disco.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EMPTY_CONTEXT_USAGE,
  type AgentDefaults,
  type ContextUsage,
  type ConversationEvent,
  type ConversationImageSource,
  type ConversationState,
  type AnswerSelection,
  type PermissionMode,
  type TerminalId,
} from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import { t } from './i18n/index.js';
import { serverTextMessage } from './i18n/server-text.js';

/** Sin configuracion leida todavia. El combo muestra "sin datos". */
const NO_DEFAULTS: AgentDefaults = { model: null, effort: null, contextWindow: null };

/** Cuantos eventos anteriores pide cada clic en "cargar anteriores". */
const PAGE_SIZE = 200;

/**
 * Cuanto se espera la confirmacion de una respuesta antes de darla por perdida.
 *
 * La confirmacion es el `tool_result` en el archivo de sesion, y el camino
 * completo es: teclas a la pty, la CLI cierra el menu y escribe la linea, el
 * seguidor la lee en su siguiente pasada. Con la CLI ociosa eso son menos de
 * dos segundos; veinte deja margen de sobra para una que este ocupada, sin que
 * un fallo real se quede escondido tanto tiempo que el usuario ya se fue.
 */
const ANSWER_CONFIRM_MS = 20_000;

/** Objetos vacios estables: devolver `{}` nuevo en cada render redibuja todo. */
const NO_ANSWERS: Record<string, AnswerSelection[]> = {};
const NO_FAILURES: Record<string, string> = {};

export interface ConversationFeed {
  events: ConversationEvent[];
  usage: ContextUsage;
  state: ConversationState;
  /**
   * Modo de permiso observado en el archivo, o null si todavia no lo dijo.
   *
   * Misma regla que el modelo y el esfuerzo: se muestra lo que la CLI hizo, no
   * lo que le pedimos. Quien lo cambie con `shift+tab` en la solapa CLI se ve
   * aca igual, y por el mismo camino.
   */
  permissionMode: PermissionMode | null;
  /**
   * Que esta esperando la CLI ahora mismo, o null si no espera nada.
   *
   * **No sale del archivo de sesion**: sale del estado que la CLI publica por
   * proceso en `~/.claude/sessions/<pid>.json`. Un permiso pendiente no deja
   * ninguna linea en el JSONL mientras espera, asi que esta es la unica forma
   * de saber que hay algo esperando sin leer la pantalla de la terminal.
   *
   * Viene crudo de la CLI (`permission prompt`, `dialog open`, ...) para que
   * una etiqueta nueva de una version futura no se pierda.
   */
  waitingFor: string | null;
  /**
   * true si la CLI no publica su estado y tiene una llamada a herramienta sin
   * resultado: puede haber un menu de aprobacion abierto que no se ve. Lo
   * calcula el servidor (`conversation.toolCall`).
   */
  openToolCall: boolean;
  /**
   * Lo que la configuracion anuncia, para cuando el archivo todavia no dijo
   * nada. Es provisional: en cuanto llega una respuesta manda lo observado.
   */
  defaults: AgentDefaults;
  /** true si hay eventos anteriores a los cargados. */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  /**
   * Imagenes ya traidas, por `eventId:index`.
   *
   * `undefined` es "todavia no se pidio", `null` es "se pidio y no estaba".
   * Distinguirlos es lo que evita pedir en bucle una imagen que no aparece.
   */
  images: Record<string, string | null>;
  requestImage: (eventId: string, index: number, source: ConversationImageSource) => void;
  /**
   * Responde la pregunta de eleccion abierta, sin pasar por la solapa CLI.
   *
   * Van los indices de lo elegido, una lista por pregunta; el servidor las
   * traduce a teclas. Cual es la pregunta lo dice `toolUseId`, y si el usuario
   * ya contesto en la terminal el servidor rechaza el mensaje.
   */
  answer: (toolUseId: string, selections: AnswerSelection[]) => void;
  /** Cambia el modo de permiso de la pestana. */
  setPermissionMode: (mode: PermissionMode) => void;
  /**
   * Preguntas ya contestadas desde aca, mientras el archivo no lo confirme.
   *
   * Existe porque entre el clic y el `tool_result` del JSONL pasan unos cientos
   * de milisegundos, y sin esto los botones siguen aceptando clics: cada uno
   * mandaria otra tanda de numeros a un menu que ya se cerro, y esos numeros
   * terminan escritos en el prompt de la CLI.
   */
  answered: Record<string, AnswerSelection[]>;
  /**
   * Preguntas cuyo envio fallo o nunca se confirmo.
   *
   * Una respuesta que no llego no puede quedar como "Respondida": el usuario
   * se queda mirando una tarjeta cerrada esperando algo que no va a pasar.
   * Aca la tarjeta vuelve a aceptar clics y lo dice.
   */
  answerFailed: Record<string, string>;
}

/**
 * Clave de una imagen dentro de la conversacion.
 *
 * El `source` es parte de la clave y no un adorno: un mensaje puede traer una
 * imagen pegada en la CLI y otra adjuntada por ruta, y las dos se numeran desde
 * cero por separado.
 */
export function imageKey(
  eventId: string,
  index: number,
  source: ConversationImageSource,
): string {
  return `${eventId}:${source}:${index}`;
}

export function useConversation(
  connection: AgentConnection,
  terminalId: TerminalId | null,
): ConversationFeed {
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  const [usage, setUsage] = useState<ContextUsage>(EMPTY_CONTEXT_USAGE);
  const [defaults, setDefaults] = useState<AgentDefaults>(NO_DEFAULTS);
  const [state, setState] = useState<ConversationState>('waiting');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [images, setImages] = useState<Record<string, string | null>>({});
  const [permissionMode, setPermissionModeState] = useState<PermissionMode | null>(null);
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const [openToolCall, setOpenToolCall] = useState(false);

  /*
    Lo respondido y lo que fallo, **indexado por pestana**.

    Estaba por conversacion y se limpiaba al cambiar de pestana, que es
    exactamente el agujero: la marca existe para que la tarjeta no acepte un
    segundo clic, y mirar otra pestana y volver la borraba. Con el
    `tool_result` todavia sin llegar al archivo, la tarjeta volvia a verse sin
    responder y un segundo clic mandaba otra tanda de numeros a un menu que ya
    no estaba abierto — que es como terminan escritos en el prompt.
  */
  const [answeredByTerminal, setAnsweredByTerminal] = useState<
    Record<string, Record<string, AnswerSelection[]>>
  >({});
  const [failedByTerminal, setFailedByTerminal] = useState<
    Record<string, Record<string, string>>
  >({});

  const answered = (terminalId === null ? undefined : answeredByTerminal[terminalId]) ?? NO_ANSWERS;
  const answerFailed = (terminalId === null ? undefined : failedByTerminal[terminalId]) ?? NO_FAILURES;

  /** Lo ya pedido, para no volver a pedirlo en cada redibujado. */
  const requested = useRef(new Set<string>());

  /** Plazos abiertos de respuestas sin confirmar, por `toolUseId`. */
  const timers = useRef(new Map<string, number>());

  /** Preguntas cuyo `tool_result` ya aparecio en el archivo. */
  const resolved = useRef(new Set<string>());

  const fail = useCallback((forTerminal: TerminalId, toolUseId: string, reason: string) => {
    setFailedByTerminal((current) => ({
      ...current,
      [forTerminal]: { ...(current[forTerminal] ?? {}), [toolUseId]: reason },
    }));
  }, []);

  /** Borra el aviso de fallo de una pregunta que resulto contestada. */
  const forgetResolved = useCallback((toolUseId: string) => {
    setFailedByTerminal((current) => {
      let changed = false;
      const next: Record<string, Record<string, string>> = {};
      for (const [key, value] of Object.entries(current)) {
        if (toolUseId in value) {
          const rest = { ...value };
          delete rest[toolUseId];
          next[key] = rest;
          changed = true;
        } else {
          next[key] = value;
        }
      }
      return changed ? next : current;
    });
  }, []);

  /** Olvida un fallo anterior de esa pregunta: se esta reintentando. */
  const forget = useCallback((forTerminal: TerminalId, toolUseId: string) => {
    setFailedByTerminal((current) => {
      const forThis = current[forTerminal];
      if (forThis === undefined || !(toolUseId in forThis)) return current;
      const rest = { ...forThis };
      delete rest[toolUseId];
      return { ...current, [forTerminal]: rest };
    });
  }, []);

  /*
    Que preguntas ya tienen su `tool_result` en el archivo.

    Es lo que cancela el plazo de una respuesta: si el resultado llego, se
    contesto — desde aca o desde la solapa CLI, da igual cual de las dos.
  */
  useEffect(() => {
    for (const event of events) {
      for (const part of event.parts) {
        if (part.kind !== 'tool-result') continue;
        resolved.current.add(part.toolUseId);
        const timer = timers.current.get(part.toolUseId);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          timers.current.delete(part.toolUseId);
        }
        /*
          Y si esa pregunta llego a marcarse como perdida, se desmarca.

          Pasa de verdad: el plazo corre para todas las pestanas, pero los
          eventos que lo cancelan son solo los de la que se esta mirando. Uno
          responde en una, se va a otra mientras la CLI escribe, y al volver
          encuentra un aviso de fallo sobre una respuesta que si llego.
        */
        forgetResolved(part.toolUseId);
      }
    }
  }, [events, forgetResolved]);

  // Los plazos son de esta pantalla: al desmontar no queda ninguno corriendo.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  // El id mas viejo cargado es el cursor de paginacion. En un ref y no en
  // estado: lo lee `loadMore` y no tiene por que redibujar nada al cambiar.
  const oldestEventId = useRef<string | null>(null);

  useEffect(() => {
    if (terminalId === null) {
      setEvents([]);
      setUsage(EMPTY_CONTEXT_USAGE);
      setDefaults(NO_DEFAULTS);
      setState('waiting');
      setHasMore(false);
      oldestEventId.current = null;
      return;
    }

    // Estado limpio al cambiar de pestana: mezclar dos conversaciones seria
    // peor que mostrar un panel vacio un instante.
    setEvents([]);
    setUsage(EMPTY_CONTEXT_USAGE);
    setDefaults(NO_DEFAULTS);
    setState('waiting');
    setHasMore(false);
    setLoadingMore(false);
    setImages({});
    setPermissionModeState(null);
    setWaitingFor(null);
    setOpenToolCall(false);
    requested.current.clear();
    oldestEventId.current = null;

    const offMessage = connection.onMessage((message) => {
      switch (message.type) {
        case 'conversation.reset':
          if (message.terminalId !== terminalId) break;
          setEvents(message.events);
          setUsage(message.usage);
          setDefaults(message.defaults);
          setPermissionModeState(message.permissionMode);
          setWaitingFor(message.waitingFor);
          setOpenToolCall(message.openToolCall);
          setState(message.state);
          setHasMore(message.hasMore);
          setLoadingMore(false);
          oldestEventId.current = message.events[0]?.eventId ?? null;
          break;

        case 'conversation.append': {
          if (message.terminalId !== terminalId) break;
          setEvents((current) => {
            // Deduplicado por id: un reset y un append pueden cruzarse en el
            // aire justo despues de reconectar.
            const known = new Set(current.map((event) => event.eventId));
            const fresh = message.events.filter((event) => !known.has(event.eventId));
            if (fresh.length === 0) return current;
            if (oldestEventId.current === null) {
              oldestEventId.current = fresh[0]?.eventId ?? null;
            }
            return [...current, ...fresh];
          });
          setUsage(message.usage);
          if (message.permissionMode !== null) setPermissionModeState(message.permissionMode);
          setState('live');
          break;
        }

        case 'conversation.page': {
          if (message.terminalId !== terminalId) break;
          setEvents((current) => {
            const known = new Set(current.map((event) => event.eventId));
            const older = message.events.filter((event) => !known.has(event.eventId));
            if (older.length === 0) return current;
            oldestEventId.current = older[0]?.eventId ?? oldestEventId.current;
            return [...older, ...current];
          });
          setHasMore(message.hasMore);
          setLoadingMore(false);
          break;
        }

        /*
          La duracion de un turno cuyo mensaje ya llego. Se le pega al evento
          que ya esta en la lista: reenviar el evento entero obligaria a
          deduplicar por nada.
        */
        case 'conversation.turns': {
          if (message.terminalId !== terminalId) break;
          const byId = new Map(message.turns.map((turn) => [turn.eventId, turn.durationMs]));
          setEvents((current) =>
            current.map((event) => {
              const durationMs = byId.get(event.eventId);
              return durationMs === undefined ? event : { ...event, durationMs };
            }),
          );
          break;
        }

        /*
          Un mensaje al que se le agrego la imagen que la CLI adjunto aparte.
          Se le reemplazan las partes al evento que ya esta en la lista, igual
          que con las duraciones: reenviar el evento entero obligaria a
          deduplicar por nada.
        */
        case 'conversation.parts': {
          if (message.terminalId !== terminalId) break;
          const byId = new Map(message.updates.map((update) => [update.eventId, update.parts]));
          setEvents((current) =>
            current.map((event) => {
              const parts = byId.get(event.eventId);
              return parts === undefined ? event : { ...event, parts };
            }),
          );
          break;
        }

        case 'conversation.imageData': {
          if (message.terminalId !== terminalId) break;
          const key = imageKey(message.eventId, message.index, message.source);
          setImages((current) => ({
            ...current,
            [key]:
              message.data === null ? null : `data:${message.mediaType};base64,${message.data}`,
          }));
          break;
        }

        case 'conversation.state':
          if (message.terminalId !== terminalId) break;
          setState(message.state);
          break;

        /*
          El modo cambio sin que llegara ningun mensaje. Es el caso de uso del
          combo: uno lo cambia y quiere ver que cambio, sin escribirle nada al
          agente.
        */
        case 'conversation.mode':
          if (message.terminalId !== terminalId) break;
          setPermissionModeState(message.mode);
          break;

        /*
          La CLI empezo o dejo de esperar algo. Llega solo, sin mensajes: el
          permiso que la tiene frenada no escribe nada en el archivo.
        */
        case 'conversation.waiting':
          if (message.terminalId !== terminalId) break;
          setWaitingFor(message.waitingFor);
          break;

        /*
          Se abrio o se cerro una llamada a herramienta de una CLI que no
          publica su estado. Tampoco trae mensajes: la linea que la cierra
          puede no ser un mensaje.
        */
        case 'conversation.toolCall':
          if (message.terminalId !== terminalId) break;
          setOpenToolCall(message.open);
          break;

        /*
          El servidor rechazo una respuesta.

          Pasa cuando la pregunta ya no esta esperando —porque se contesto en
          la solapa CLI— o cuando lo elegido no casa con su forma. El aviso no
          dice de que pregunta se trata, y no hace falta: solo puede haber una
          abierta a la vez, asi que se marcan las que estaban esperando
          confirmacion. Lo importante es que la tarjeta deje de mentir.
        */
        case 'error': {
          if (message.code !== 'answer-failed') break;
          if (terminalId === null) break;
          for (const [toolUseId, timer] of timers.current) {
            window.clearTimeout(timer);
            timers.current.delete(toolUseId);
            setAnsweredByTerminal((current) => {
              const forTerminal = current[terminalId];
              if (forTerminal === undefined || !(toolUseId in forTerminal)) return current;
              const rest = { ...forTerminal };
              delete rest[toolUseId];
              return { ...current, [terminalId]: rest };
            });
            fail(terminalId, toolUseId, serverTextMessage(message.text));
          }
          break;
        }

        default:
          break;
      }
    });

    connection.send({ type: 'conversation.subscribe', terminalId });
    // Tras una reconexion hay que volver a pedirla: el servidor solo mantiene
    // el seguimiento mientras haya alguien enganchado.
    const offReopen = connection.onReopen(() => {
      connection.send({ type: 'conversation.subscribe', terminalId });
    });

    return () => {
      offMessage();
      offReopen();
      connection.send({ type: 'conversation.unsubscribe', terminalId });
    };
  }, [connection, terminalId, fail]);

  const loadMore = useCallback(() => {
    const before = oldestEventId.current;
    if (terminalId === null || before === null || loadingMore) return;
    setLoadingMore(true);
    connection.send({
      type: 'conversation.loadMore',
      terminalId,
      beforeEventId: before,
      limit: PAGE_SIZE,
    });
  }, [connection, terminalId, loadingMore]);

  const requestImage = useCallback(
    (eventId: string, index: number, source: ConversationImageSource) => {
      if (terminalId === null) return;
      const key = imageKey(eventId, index, source);
      if (requested.current.has(key)) return;
      requested.current.add(key);
      connection.send({ type: 'conversation.image', terminalId, eventId, index, source });
    },
    [connection, terminalId],
  );

  const answer = useCallback(
    (toolUseId: string, selections: AnswerSelection[]) => {
      if (terminalId === null) return;
      // Se marca antes de mandar, no al confirmarse: lo que hay que cortar es
      // el segundo clic, y ese llega mucho antes que la confirmacion.
      setAnsweredByTerminal((current) => {
        const forTerminal = current[terminalId] ?? {};
        if (toolUseId in forTerminal) return current;
        return { ...current, [terminalId]: { ...forTerminal, [toolUseId]: selections } };
      });
      forget(terminalId, toolUseId);
      connection.send({ type: 'agent.answer', terminalId, toolUseId, selections });

      /*
        Y se le pone un plazo.

        Responder escribe teclas a ciegas en un menu (§5.5): si la CLI estaba
        ocupada, o el menu ya no estaba donde lo dejamos, la secuencia se queda
        a mitad y **no pasa nada mas**. Sin esto la tarjeta se queda diciendo
        "Respondida" para siempre y el usuario espera algo que no va a llegar.
        Pasado el plazo sin que aparezca el `tool_result` en el archivo, la
        tarjeta lo dice y vuelve a aceptar clics; un reintento tardio que la
        CLI ya no espera lo rechaza el servidor, que mira si la pregunta sigue
        abierta antes de escribir nada.
      */
      const timer = window.setTimeout(() => {
        if (resolved.current.has(toolUseId)) return;
        setAnsweredByTerminal((current) => {
          const forTerminal = current[terminalId];
          if (forTerminal === undefined || !(toolUseId in forTerminal)) return current;
          const rest = { ...forTerminal };
          delete rest[toolUseId];
          return { ...current, [terminalId]: rest };
        });
        fail(terminalId, toolUseId, t('conversation.answerUnconfirmed'));
      }, ANSWER_CONFIRM_MS);
      timers.current.set(toolUseId, timer);
    },
    [connection, terminalId, fail, forget],
  );

  const setPermissionMode = useCallback(
    (mode: PermissionMode) => {
      if (terminalId === null) return;
      connection.send({ type: 'agent.mode', terminalId, mode });
    },
    [connection, terminalId],
  );

  return {
    events,
    usage,
    defaults,
    state,
    permissionMode,
    waitingFor,
    openToolCall,
    hasMore,
    loadingMore,
    loadMore,
    images,
    requestImage,
    answer,
    answered,
    answerFailed,
    setPermissionMode,
  };
}
