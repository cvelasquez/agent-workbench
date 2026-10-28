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
  type ConversationQuestionPart,
  type ConversationState,
  type ConversationSubagent,
  type AnswerSelection,
  type PermissionMode,
  type QueuedPrompt,
  type TerminalId,
} from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import { t } from './i18n/index.js';
import { serverTextMessage } from './i18n/server-text.js';
import { liveCarryOvers, type LiveAnswerRecord } from './live-question-ui.js';
import { EDIT_STOP_HOLD_MS, markEditStop } from './sent-edit.js';

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
const NO_SUBAGENTS: ConversationSubagent[] = [];
const NO_QUEUE: QueuedPrompt[] = [];

/**
 * Cuanto se muestra "Enviando…" en el boton de forzar el envio si la cola no
 * cambia. La CLI suele contestar en un segundo; esto es para que el boton no
 * quede apagado para siempre si no lo hace.
 */
const FORCE_SEND_HOLD_MS = 15_000;

/**
 * Lo mismo para sacar la cola y editarla (§6.35.1): el servidor contesta
 * siempre, en unos segundos; esto es por si la respuesta no llega.
 */
const QUEUE_EDIT_HOLD_MS = 20_000;

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
   * Los subagentes del proceso vivo que siguen trabajando (§4.15). Lo calcula
   * el servidor (`conversation.subagents`); vacio con una CLI que no los sigue.
   */
  subagents: ConversationSubagent[];
  /**
   * Los mensajes que esperan en la cola de la CLI (hito 45, §6.35). Lo calcula
   * el servidor (`conversation.queue`, y dentro del `append` que la cambia);
   * vacia con una CLI que no hace cola.
   */
  queue: QueuedPrompt[];
  /** Pide que el agente lea ya lo que espera en la cola ("Forzar envio ahora"). */
  forceSend: () => void;
  /** true desde el clic hasta que la cola cambia, el servidor dice que no, o pasa un rato. */
  forcing: boolean;
  /** Saca de la cola de la CLI todo lo que espera y lo trae al cuadro, para editarlo (§6.35.1). */
  editQueue: () => void;
  /** true desde el pedido hasta su respuesta, o hasta que pasa un rato. */
  editingQueue: boolean;
  /**
   * "Editar" en la burbuja "enviado" (§6.35.2): lo mismo que Detener, y la CLI
   * devuelve el mensaje al cuadro porque el agente no empezo (§4.16).
   */
  editSent: () => void;
  /** true desde el clic hasta que la burbuja se va, o hasta que pasa un rato. */
  editingSent: boolean;
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
  /**
   * La pregunta que la CLI tiene abierta, leida de su pantalla (§5.5.4), o
   * null. Va al final del hilo: la CLI todavia no la escribio en su historial,
   * y al contestarla la escribe y aparece en su lugar.
   */
  liveQuestion: ConversationQuestionPart | null;
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
  const [subagents, setSubagents] = useState<ConversationSubagent[]>(NO_SUBAGENTS);
  const [queue, setQueue] = useState<QueuedPrompt[]>(NO_QUEUE);
  const [liveQuestion, setLiveQuestion] = useState<ConversationQuestionPart | null>(null);
  /**
   * La pregunta leida de la pantalla que tiene abierta cada pestana, por su id.
   * De todas, no solo de la que se mira: el plazo de una respuesta puede vencer
   * con otra pestana a la vista, y tiene que saber si la pregunta se fue.
   */
  const liveIds = useRef(new Map<TerminalId, string>());
  /**
   * Lo que se mando en una pregunta leida de la pantalla, hasta que la CLI la
   * escribe en el historial. Ahi la tarjeta de verdad hereda lo que tenia la
   * leida: lo elegido, con su plazo, o el rechazo, con su aviso. La CLI puede
   * escribirla en cualquier momento, tambien entre el clic y la respuesta del
   * servidor (medido el 23-10-2026), y la tarjeta leida se va en ese instante.
   */
  const liveAnswers = useRef(new Map<string, LiveAnswerRecord>());
  const [forcing, setForcing] = useState(false);
  /** El `requestId` del ultimo "forzar envio", hasta su respuesta. */
  const forceRequest = useRef<string | null>(null);
  const forceTimer = useRef<number | null>(null);
  const [editingQueue, setEditingQueue] = useState(false);
  /** El `requestId` del ultimo pedido de editar la cola, hasta su respuesta. */
  const editRequest = useRef<string | null>(null);
  const editTimer = useRef<number | null>(null);
  const [editingSent, setEditingSent] = useState(false);
  const editSentTimer = useRef<number | null>(null);

  const stopEditingSent = useCallback(() => {
    if (editSentTimer.current !== null) window.clearTimeout(editSentTimer.current);
    editSentTimer.current = null;
    setEditingSent(false);
  }, []);

  const stopForcing = useCallback(() => {
    forceRequest.current = null;
    if (forceTimer.current !== null) window.clearTimeout(forceTimer.current);
    forceTimer.current = null;
    setForcing(false);
  }, []);

  const stopEditing = useCallback(() => {
    editRequest.current = null;
    if (editTimer.current !== null) window.clearTimeout(editTimer.current);
    editTimer.current = null;
    setEditingQueue(false);
  }, []);

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
    El plazo de una respuesta mandada desde una tarjeta.

    Responder escribe teclas en un menu (§5.5): si la CLI estaba ocupada, o el
    menu ya no estaba donde lo dejamos, la secuencia se queda a mitad y **no pasa
    nada mas**. Sin esto la tarjeta se queda diciendo "Respondida" para siempre
    y el usuario espera algo que no va a llegar. Pasado el plazo sin que aparezca
    el `tool_result` en el archivo, la tarjeta lo dice y vuelve a aceptar clics;
    un reintento tardio que la CLI ya no espera lo rechaza el servidor, que mira
    si la pregunta sigue abierta antes de escribir nada.

    `live`: la pregunta era la leida de la pantalla (§5.5.4). Esa no tiene
    `tool_result` con su id: la CLI la escribe con el suyo. Si al vencer ya no
    esta en pantalla, se contesto, o la reemplazo la del historial, que tiene su
    propio plazo; si sigue, las teclas no hicieron nada.
  */
  const armConfirmTimer = useCallback(
    (forTerminal: TerminalId, toolUseId: string, live: boolean) => {
      const previous = timers.current.get(toolUseId);
      if (previous !== undefined) window.clearTimeout(previous);
      const timer = window.setTimeout(() => {
        timers.current.delete(toolUseId);
        if (resolved.current.has(toolUseId)) return;
        if (live && liveIds.current.get(forTerminal) !== toolUseId) return;
        setAnsweredByTerminal((current) => {
          const forThis = current[forTerminal];
          if (forThis === undefined || !(toolUseId in forThis)) return current;
          const rest = { ...forThis };
          delete rest[toolUseId];
          return { ...current, [forTerminal]: rest };
        });
        fail(forTerminal, toolUseId, t('conversation.answerUnconfirmed'));
      }, ANSWER_CONFIRM_MS);
      timers.current.set(toolUseId, timer);
    },
    [fail],
  );

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

  /*
    Una pregunta que se mando leida de la pantalla (§5.5.4) llega al historial
    con el id de la CLI, antes o despues de contestarse. Su tarjeta hereda lo
    de la leida: lo elegido y su plazo (sin esto aceptaria un segundo clic, o
    diria "Respondida" sin decir que), o el rechazo y su aviso (sin esto diria
    "Respondida" con la CLI esperando).
  */
  useEffect(() => {
    if (terminalId === null || liveAnswers.current.size === 0) return;
    for (const { liveId, toolUseId, selections, failure } of liveCarryOvers(events, liveAnswers.current, terminalId)) {
      liveAnswers.current.delete(liveId);
      if (selections !== null) {
        setAnsweredByTerminal((current) => {
          const forTerminal = current[terminalId] ?? {};
          if (toolUseId in forTerminal) return current;
          return { ...current, [terminalId]: { ...forTerminal, [toolUseId]: selections } };
        });
        if (!resolved.current.has(toolUseId)) armConfirmTimer(terminalId, toolUseId, false);
      }
      if (failure !== null) fail(terminalId, toolUseId, failure);
    }
  }, [events, terminalId, armConfirmTimer, fail]);

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
    setSubagents(NO_SUBAGENTS);
    setQueue(NO_QUEUE);
    // La del `reset` que pide la suscripcion trae la de esta pestana.
    setLiveQuestion(null);
    stopForcing();
    stopEditing();
    requested.current.clear();
    oldestEventId.current = null;

    const offMessage = connection.onMessage((message) => {
      // La pregunta leida de la pantalla de cada pestana, aunque no sea esta (ver `liveIds`).
      if (message.type === 'conversation.reset' || message.type === 'conversation.liveQuestion') {
        const question = message.type === 'conversation.reset' ? message.liveQuestion : message.question;
        if (question === null) liveIds.current.delete(message.terminalId);
        else liveIds.current.set(message.terminalId, question.toolUseId);
      }

      switch (message.type) {
        case 'conversation.reset':
          if (message.terminalId !== terminalId) break;
          setLiveQuestion(message.liveQuestion);
          setEvents(message.events);
          setUsage(message.usage);
          setDefaults(message.defaults);
          setPermissionModeState(message.permissionMode);
          setWaitingFor(message.waitingFor);
          setOpenToolCall(message.openToolCall);
          setSubagents(message.subagents);
          setQueue(message.queue);
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
          // La cola que cambio con estos mensajes: en el mismo dibujo, la burbuja se va y el mensaje aparece.
          if (message.queue !== undefined) setQueue(message.queue);
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
          Los subagentes que siguen trabajando cambiaron. Tampoco trae mensajes:
          el aviso de que uno termino no es una tarjeta.
        */
        case 'conversation.subagents':
          if (message.terminalId !== terminalId) break;
          setSubagents(message.subagents);
          break;

        /*
          La cola de la CLI cambio sin mensajes nuevos (hito 45): se mando uno
          con el agente trabajando, se forzo el envio, o la CLI quedo libre.
        */
        case 'conversation.queue':
          if (message.terminalId !== terminalId) break;
          setQueue(message.queue);
          break;

        /*
          La pregunta que la CLI tiene abierta, leida de su pantalla (§5.5.4):
          aparecio, cambio o se fue. Llega sola: la CLI todavia no escribio nada.
        */
        case 'conversation.liveQuestion':
          if (message.terminalId !== terminalId) break;
          setLiveQuestion(message.question);
          break;

        // Forzar el envio no se hizo: el motivo llega en su `error`, y el boton vuelve.
        case 'agent.forceSent':
          if (message.requestId === forceRequest.current && !message.sent) stopForcing();
          break;

        // Sacar la cola termino: el texto ya llego al cuadro, o el motivo en su `error`.
        case 'agent.queueEdited':
          if (message.requestId === editRequest.current) stopEditing();
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
          if (message.requestId !== undefined && message.requestId === forceRequest.current) {
            stopForcing();
            break;
          }
          if (message.requestId !== undefined && message.requestId === editRequest.current) {
            stopEditing();
            break;
          }
          if (message.code !== 'answer-failed') break;
          if (terminalId === null) break;
          const reason = serverTextMessage(message.text);
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
            fail(terminalId, toolUseId, reason);
            // La leida que todavia no llego al historial: su tarjeta de verdad hereda el rechazo.
            const record = liveAnswers.current.get(toolUseId);
            if (record !== undefined) liveAnswers.current.set(toolUseId, { ...record, selections: null, failure: reason });
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
  }, [connection, terminalId, fail, stopForcing, stopEditing]);

  /*
    El boton deja de decir "Enviando…" cuando ya no queda nada sin forzar: la
    CLI lo entrego (la cola se vacio) o ya se lo esta pasando al agente.
  */
  useEffect(() => {
    // Lo enviado con la CLI libre no se fuerza (§6.35.2): solo cuenta lo que espera en la cola.
    if (forcing && queue.every((prompt) => prompt.sent === true || prompt.forced === true)) stopForcing();
  }, [forcing, queue, stopForcing]);

  // "Editar" termino cuando la burbuja se fue: el texto volvio al cuadro, o el agente ya habia empezado.
  useEffect(() => {
    if (editingSent && !queue.some((prompt) => prompt.sent === true)) stopEditingSent();
  }, [editingSent, queue, stopEditingSent]);

  // El plazo es de esta pantalla: al desmontar no queda corriendo.
  useEffect(
    () => () => {
      if (forceTimer.current !== null) window.clearTimeout(forceTimer.current);
      if (editTimer.current !== null) window.clearTimeout(editTimer.current);
      if (editSentTimer.current !== null) window.clearTimeout(editSentTimer.current);
    },
    [],
  );

  const forceSend = useCallback(() => {
    if (terminalId === null || forceRequest.current !== null) return;
    const requestId = crypto.randomUUID();
    forceRequest.current = requestId;
    setForcing(true);
    if (forceTimer.current !== null) window.clearTimeout(forceTimer.current);
    forceTimer.current = window.setTimeout(stopForcing, FORCE_SEND_HOLD_MS);
    connection.send({ type: 'agent.forceSend', terminalId, requestId });
  }, [connection, terminalId, stopForcing]);

  const editQueue = useCallback(() => {
    if (terminalId === null || editRequest.current !== null) return;
    const requestId = crypto.randomUUID();
    editRequest.current = requestId;
    setEditingQueue(true);
    if (editTimer.current !== null) window.clearTimeout(editTimer.current);
    editTimer.current = window.setTimeout(stopEditing, QUEUE_EDIT_HOLD_MS);
    connection.send({ type: 'agent.editQueue', terminalId, requestId });
  }, [connection, terminalId, stopEditing]);

  const editSent = useCallback(() => {
    if (terminalId === null || editingSent) return;
    setEditingSent(true);
    if (editSentTimer.current !== null) window.clearTimeout(editSentTimer.current);
    editSentTimer.current = window.setTimeout(stopEditingSent, EDIT_STOP_HOLD_MS);
    // El texto vuelve con el motivo de Detener: sin aviso y con el foco, porque lo pidio el usuario.
    markEditStop(terminalId);
    connection.send({ type: 'agent.interrupt', terminalId });
  }, [connection, terminalId, editingSent, stopEditingSent]);

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
      // La leida de la pantalla: se anota para que la tarjeta de verdad herede lo que pase.
      const live = liveQuestion?.toolUseId === toolUseId ? liveQuestion.questions[0] : undefined;
      if (live !== undefined) liveAnswers.current.set(toolUseId, { terminalId, item: live, selections, failure: null });
      connection.send({ type: 'agent.answer', terminalId, toolUseId, selections });
      // Y se le pone un plazo (ver `armConfirmTimer`).
      armConfirmTimer(terminalId, toolUseId, live !== undefined);
    },
    [connection, terminalId, forget, liveQuestion, armConfirmTimer],
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
    subagents,
    queue,
    forceSend,
    forcing,
    editQueue,
    editingQueue,
    editSent,
    editingSent,
    hasMore,
    loadingMore,
    loadMore,
    images,
    requestImage,
    answer,
    answered,
    answerFailed,
    setPermissionMode,
    liveQuestion,
  };
}
