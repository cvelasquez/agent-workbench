/**
 * Seguimiento incremental de un archivo de sesion de Claude Code.
 *
 * La lectura por offset —lineas partidas, UTF-8 cortado, archivo que encoge,
 * tope y paginado— vive en `JsonlFollower` (`agents/jsonl-follower.ts`), que es
 * de todas las CLIs. Esta clase es el **sink** de ese seguidor: lo que cada
 * linea del JSONL de Claude Code significa (eventos, medidor, modo de permiso,
 * planes, imagenes adjuntas).
 *
 * Se partio asi en el hito 25 sin cambiar nada observable: la API publica es la
 * misma y `check-conversation-follower.mjs` no se toco.
 */

import {
  EMPTY_CONTEXT_USAGE,
  contextWindowFor,
  fitWindowToObserved,
  isPermissionMode,
  modelFamilyOf,
  modelVariantBase,
  type ContextUsage,
  type ConversationEvent,
  type ConversationPart,
  type ConversationState,
  type PermissionMode,
} from '@agent-workbench/shared';
import {
  stripFileReference,
  toPlanRefs,
  toConversationEvent,
  toTurnDuration,
  toUserImageAttachment,
  type UserImageAttachment,
} from './jsonl-events.js';
import type { EventPage, FollowOptions, PartsUpdate, PollResult, TurnUpdate } from '../adapter.js';
import { JsonlFollower, type EventLookup, type JsonlLineSink } from '../jsonl-follower.js';
import { TRANSPORT_LIMITS, type EventLimits } from '../transport-limits.js';
import { ModelVariantRegistry } from './model-variants.js';

/**
 * Cuantos eslabones de la cadena de adjuntos se recuerdan.
 *
 * Cada entrada solo sirve para el adjunto que venga justo despues, asi que con
 * cien alcanza de sobra: en la instalacion entera hay 39 adjuntos de imagen.
 */
const MAX_ATTACHMENT_LINKS = 100;

/**
 * Cuantos documentos se recuerdan por sesion (hito 31).
 *
 * Los planes de `~/.claude/plans/` son tres o cuatro; los `.md` que el agente
 * escribe en el proyecto o en la temporal pueden ser muchos mas, y la solapa
 * es una lista para leer, no un listado de carpeta.
 */
const MAX_PLAN_REFS = 50;

/**
 * Lo que recibe el seguidor ademas de los topes de transporte.
 *
 * `target` es la pestana, y con ella las raices de los documentos (hito 31).
 * Ausente: solo los planes de `~/.claude/plans/`, como antes del hito.
 */
export interface ConversationFollowerOptions extends FollowOptions {
  target?: { cwd: string; sessionId: string };
}

export class ConversationFollower implements JsonlLineSink {
  /** La lectura del archivo. Esta clase es su sink. */
  private readonly jsonl: JsonlFollower;
  private usage: ContextUsage = { ...EMPTY_CONTEXT_USAGE };
  /** Duraciones vistas durante la lectura en curso. */
  private turns: TurnUpdate[] = [];

  /** Eventos a los que se les cambiaron las partes durante la lectura en curso. */
  private partUpdates: PartsUpdate[] = [];

  /**
   * Variantes vistas en **este** archivo.
   *
   * Manda sobre lo que sepa la instalacion: si esta conversacion trae su propio
   * `cost-state`, eso es lo que corrio aca, y no lo que el usuario tenga
   * configurado ahora.
   */
  private sessionVariants = new ModelVariantRegistry();

  /**
   * Variante que declara la configuracion (`opus[1m]`), o null.
   *
   * Cierra el ultimo agujero del §4.5.1: `message.model` **nunca** trae el
   * sufijo, asi que una sesion de 1M se veia como una de 200k hasta que
   * apareciera un `cost-state` —que llega tarde, o no llega—. La configuracion
   * si lo dice, porque la CLI la reescribe cuando aceptan un `/model`: correr
   * `/model opus[1m]` deja `"model": "opus[1m]"` en `settings.json`.
   *
   * Por eso la fuente de verdad es el archivo de configuracion y no el comando
   * que se ve pasar en la conversacion: el comando es lo que se **pidio**, y
   * §5.4 ya explica por que eso no se guarda. Si la CLI lo rechaza, la
   * configuracion no cambia y aca no cambia nada.
   */
  private configuredAlias: string | null = null;

  /** true cuando paso un `/model`: la configuracion pudo haber cambiado. */
  private configuredStale = false;

  /**
   * true si esta sesion vio pasar un `/model`.
   *
   * Es lo que decide si la configuracion puede **quitar** una variante, y no
   * solo agregarla. Sin un `/model` de por medio, un alias sin sufijo no
   * distingue "elegi 200k" de "este nombre no menciona la ventana", y bajarle
   * la ventana a una sesion del historial por lo que dice la configuracion de
   * hoy seria reescribir el pasado. Con un `/model` en el archivo no hay
   * ambiguedad: el usuario acaba de elegir, y la CLI lo confirmo guardandolo.
   */
  private configuredDecides = false;

  /** Ultimo modelo crudo visto, para rehacer la cuenta sin releer el archivo. */
  private lastRawModel: string | null = null;

  /**
   * Modo de permiso segun la ultima linea `permission-mode` del archivo.
   *
   * Es lo unico observable del modo, y alcanza: la CLI escribe esa linea en
   * cada turno y tambien cuando el usuario cicla con `shift+tab` en la solapa
   * CLI. Medido sobre un archivo real de esta instalacion, donde el valor pasa
   * de `default` a `acceptEdits` en la linea 64 sin que nadie lo anunciara de
   * otra forma.
   *
   * Null mientras el archivo no lo diga —una sesion recien abierta no tiene
   * ninguna—, y ahi vale con que se lanzo la pestana (`LAUNCH_PERMISSION_MODE`).
   */
  private permissionMode: PermissionMode | null = null;

  /** Los topes de cada parte. Los de transporte salvo que se lea para la copia propia. */
  private readonly limits: EventLimits;

  /**
   * `installVariants`: lo que sabemos de la instalacion, para las sesiones que
   * todavia no escribieron ningun `cost-state` — que son casi todas mientras se
   * trabaja.
   *
   * `options` (hito 28): sin nada, como siempre. Con `limits` y `maxEvents`, la
   * sesion entera con esos topes, que es como la lee la copia propia.
   */
  /**
   * `options.target` es la pestana: de ahi salen las **raices** de los
   * documentos que la conversacion nombra (hito 31). Sin `cwd` solo se
   * reconocen los planes de la CLI, que es lo que pasaba antes; sin
   * `sessionId`, tampoco los de la carpeta temporal.
   *
   * Va en las opciones y no como parametro para no correr `installVariants`,
   * que es posicional y lo pasan los chequeos.
   */
  constructor(
    filePath: string,
    private readonly installVariants?: ModelVariantRegistry,
    options: ConversationFollowerOptions = {},
  ) {
    this.limits = options.limits ?? TRANSPORT_LIMITS;
    this.target = options.target ?? { cwd: '', sessionId: '' };
    this.jsonl = new JsonlFollower(filePath, this, { maxEvents: options.maxEvents });
  }

  /** La pestana cuyos documentos se reconocen. Ver el constructor. */
  private readonly target: { cwd: string; sessionId: string };

  /** La ruta que se sigue. Siempre fija: esta CLI la conoce al lanzar. */
  get filePath(): string {
    return this.jsonl.filePath as string;
  }

  /** Planes que esta conversacion nombro, en orden de aparicion. */
  getPlanFiles(): readonly string[] {
    return this.planFiles;
  }

  /** La configuracion que rige esta pestana. La relee el hub. */
  setConfiguredAlias(alias: string | null): void {
    this.configuredAlias = alias;
    this.configuredStale = false;
  }

  /** true una sola vez por `/model` visto: el hub relee la configuracion. */
  takeConfiguredStale(): boolean {
    const stale = this.configuredStale;
    this.configuredStale = false;
    return stale;
  }

  /**
   * Rehace modelo y ventana con lo que se sepa ahora, sin tocar el archivo.
   *
   * Se llama cuando cambia la configuracion a mitad de sesion: el usage ya
   * estaba calculado con el alias viejo y nadie va a recalcularlo hasta la
   * proxima respuesta, que puede tardar. Sin esto, `/model opus[1m]` no movia
   * la barra hasta el turno siguiente.
   */
  recomputeModel(): void {
    if (this.usage.assistantMessages === 0) return;
    const model = this.resolveModel(this.lastRawModel);
    const fitted = fitWindowToObserved(contextWindowFor(model), this.usage.lastRequestTokens);
    this.usage = {
      ...this.usage,
      lastModel: model,
      contextWindow: fitted.window,
      contextWindowEstimated: fitted.estimated,
    };
  }

  getState(): ConversationState {
    return this.jsonl.getState();
  }

  /** El modo de permiso que dice el archivo, o null si todavia no lo dijo. */
  getPermissionMode(): PermissionMode | null {
    return this.permissionMode;
  }

  getUsage(): ContextUsage {
    return this.usage;
  }

  /** Ultimos `limit` eventos, que es lo que se quiere ver al abrir el panel. */
  getTail(limit: number): EventPage {
    return this.jsonl.getTail(limit);
  }

  /** Tramo anterior a un evento ya entregado. Vacio si ese id ya no esta. */
  getPageBefore(beforeEventId: string, limit: number): EventPage {
    return this.jsonl.getPageBefore(beforeEventId, limit);
  }

  /**
   * Lee lo que haya de nuevo.
   *
   * No lanza si el archivo no existe: entre que se abre una pestana y el
   * usuario manda el primer mensaje, no existe, y eso es lo normal.
   */
  async poll(): Promise<PollResult> {
    this.turns = [];
    this.partUpdates = [];
    this.freshPlans = [];
    const { reset, added } = await this.jsonl.poll();
    // Lo que se aplico a un evento de este mismo lote ya viaja dentro de el.
    const fresh = new Set(added.map((event) => event.eventId));
    const turns = this.turns.filter((turn) => !fresh.has(turn.eventId));
    /*
      Un mensaje con dos imagenes deja dos actualizaciones del mismo evento, y
      la ultima ya trae las dos partes: se manda una sola. `Map` conserva el
      orden de la primera aparicion y se queda con el ultimo valor, que es
      exactamente lo que hace falta.
    */
    const parts = [
      ...new Map(
        this.partUpdates
          .filter((update) => !fresh.has(update.eventId))
          .map((update) => [update.eventId, update]),
      ).values(),
    ];
    const plans = this.freshPlans;
    this.turns = [];
    this.partUpdates = [];
    this.freshPlans = [];
    return { reset, added, turns, plans, parts };
  }

  /**
   * Del sink: el archivo encogio o desaparecio.
   *
   * Offset, lineas y eventos los olvida `JsonlFollower`; aca va lo que se
   * acumulo leyendolos. Lo que viene de afuera del archivo —la configuracion,
   * lo aprendido de la instalacion— no se toca, igual que antes de partir la
   * clase.
   */
  reset(): void {
    this.usage = { ...EMPTY_CONTEXT_USAGE };
    this.permissionMode = null;
    this.attachmentRoots.clear();
    this.planFiles = [];
  }

  /** true si la linea es la invocacion de `/model` que la CLI guarda. */
  private mentionsModelCommand(record: Record<string, unknown>): boolean {
    const message = record['message'];
    if (typeof message !== 'object' || message === null) return false;
    const content = (message as Record<string, unknown>)['content'];
    return typeof content === 'string' && content.includes('<command-name>/model</command-name>');
  }

  /**
   * Del sink: una linea completa y ya parseada. Nunca lanza: el esquema cambia
   * entre versiones.
   *
   * El evento que devuelve lo guarda `JsonlFollower`, con su tope; `events` son
   * los que ya guardo, para pegarle a uno anterior la duracion o una imagen.
   */
  consume(
    record: Record<string, unknown>,
    lineNumber: number,
    events: EventLookup,
  ): ConversationEvent | null {
    /*
      `cost-state` no es una tarjeta de la conversacion, pero es la unica linea
      que nombra el modelo con su variante. Se mira antes de descartarla.
    */
    if (record['type'] === 'cost-state') {
      this.sessionVariants.observeCostState(record, Date.now());
      /*
        Y se rehace la cuenta en el acto. Esta linea llega **despues** del
        ultimo `assistant` —§4.5.1: linea 614 de 671, 1383 de 1386—, con lo que
        el usage ya se habia calculado sin conocer la variante y nadie lo
        revisaba hasta la respuesta siguiente. Es la razon por la que el
        medidor tardaba un turno entero en corregirse.
      */
      this.recomputeModel();
      return null;
    }

    /*
      Un documento que la conversacion escribio: el plan del modo plan, o un
      `.md` que el agente dejo en el proyecto o en la temporal de la sesion
      (hito 31). Tampoco es una tarjeta: se lee en su solapa. La linea que lo
      nombra sigue su camino normal —un `Write` si es una tarjeta— asi que esto
      no devuelve.
    */
    for (const ref of toPlanRefs(record, this.target)) {
      if (this.planFiles.includes(ref)) continue;
      // Tope: una conversacion larga que escribe documentos en cada turno no
      // puede llenar la solapa ni el mensaje del socket. Gana lo primero que
      // escribio, que es donde suele estar el plan.
      if (this.planFiles.length >= MAX_PLAN_REFS) break;
      this.planFiles.push(ref);
      this.freshPlans.push(ref);
    }

    /*
      El modo de permiso. Como `cost-state`, no es una tarjeta de la
      conversacion pero es la unica fuente de un dato que se muestra.
    */
    if (record['type'] === 'permission-mode') {
      const mode = record['permissionMode'];
      if (isPermissionMode(mode)) this.permissionMode = mode;
      return null;
    }

    /*
      Un `/model` que paso por la CLI. No se lee su argumento —eso es lo
      pedido—: solo marca que la configuracion pudo cambiar, para que el hub la
      relea. La CLI la reescribe cuando acepta el comando, asi que un comando
      rechazado no mueve nada.
    */
    if (record['type'] === 'user' && this.mentionsModelCommand(record)) {
      this.configuredStale = true;
      this.configuredDecides = true;
      /*
        Y lo aprendido antes en este archivo queda viejo: un `cost-state` de
        hace veinte turnos describe con que corria la sesion **antes** del
        cambio. Sin esto, cambiar de 1M a 200k no movia la barra, porque la
        variante vieja seguia ganandole a la configuracion nueva.
      */
      this.sessionVariants = new ModelVariantRegistry();
    }

    /*
      La duracion del turno no es una tarjeta: es un dato de una tarjeta que ya
      existe. Se le pega al evento que nombra y se anota, por si ese evento ya
      viajo al cliente en una lectura anterior.
    */
    const turn = toTurnDuration(record);
    if (turn !== null) {
      const target = events.find(turn.eventId);
      if (target !== undefined) {
        target.durationMs = turn.durationMs;
        this.turns.push(turn);
      }
      return null;
    }

    /*
      Una imagen que la CLI adjunto por ruta. Tampoco es una tarjeta: es una
      parte de una que ya existe, y se aplica igual que la duracion del turno.
    */
    const attachment = toUserImageAttachment(record);
    if (attachment !== null) {
      this.applyImageAttachment(attachment, events);
      return null;
    }

    const event = toConversationEvent(record, lineNumber, this.limits);
    if (event === null) return null;

    // Antes de que `JsonlFollower` lo guarde, en el mismo orden que siempre.
    this.accumulate(event);
    return event;
  }

  /**
   * De que mensaje cuelga cada linea `attachment` ya vista.
   *
   * Con dos imagenes en un mensaje, la CLI **encadena** los adjuntos: el
   * segundo trae como `parentUuid` el `uuid` del primero, no el del mensaje
   * (§4.9.2). Buscar el evento por ese id no encuentra nada —un adjunto no es
   * un evento— y la segunda imagen se perdia: sin miniatura, y con su `@"ruta"`
   * de sesenta caracteres todavia en el texto.
   *
   * Es un mapa y no una busqueda hacia atras porque la cadena puede ser de
   * cualquier largo, y cada eslabon ya paso por aca.
   */
  private readonly attachmentRoots = new Map<string, string>();

  /**
   * Documentos de esta sesion, en el orden en que la conversacion los nombro.
   *
   * Es una lista y no un Set porque el orden es informacion —el ultimo plan es
   * casi siempre el que interesa— y aun asi no se repiten: la misma sesion
   * nombra el mismo archivo varias veces (una linea `plan_mode` por turno del
   * modo plan, mas el `Write`).
   */
  private planFiles: string[] = [];

  /** Los que aparecieron en esta pasada, para avisarlos. */
  private freshPlans: string[] = [];

  /**
   * Le pega al mensaje la imagen que la CLI adjunto en la linea siguiente.
   *
   * Dos cosas pasan aca, y la segunda es la mitad del sentido de todo esto:
   *
   *  1. Se agrega la parte `image`, con su indice dentro de las adjuntas de
   *     **ese** mensaje. Van antes del texto, en el orden en que llegaron, que
   *     es como se ven en el cuadro de escritura antes de mandarlas.
   *  2. Se saca del texto el `@"C:\…\pegada-2-7b3a5273.png"` que la nombra. Sin
   *     esto el hilo muestra sesenta caracteres de ruta al lado de la miniatura
   *     de la misma imagen. En la solapa CLI la ruta se sigue viendo, que es
   *     donde corresponde: ahi es lo que de verdad se tecleo.
   *
   * Un texto que se queda vacio no deja tarjeta —el mensaje era solo la
   * imagen—, igual que hace `toConversationEvent` con cualquier texto vacio.
   *
   * Si el mensaje no esta —quedo fuera del tope de eventos, o el archivo
   * arranca a mitad— no se hace nada. Una imagen suelta sin su mensaje no es
   * una tarjeta que valga la pena inventar.
   */
  private applyImageAttachment(attachment: UserImageAttachment, events: EventLookup): void {
    // El padre puede ser el mensaje o el adjunto anterior. En el segundo caso,
    // el mensaje es el que ya se anoto para ese eslabon.
    const rootId = this.attachmentRoots.get(attachment.eventId) ?? attachment.eventId;
    if (attachment.attachmentId.length > 0) {
      this.rememberAttachment(attachment.attachmentId, rootId);
    }

    const target = events.find(rootId);
    if (target === undefined) return;

    const isAttached = (part: ConversationPart): boolean =>
      part.kind === 'image' && part.source === 'attachment';

    const image: ConversationPart = {
      kind: 'image',
      index: target.parts.filter(isAttached).length,
      mediaType: attachment.mediaType,
      source: 'attachment',
    };

    const cleaned = target.parts
      .map((part) =>
        part.kind === 'text'
          ? { ...part, text: stripFileReference(part.text, attachment.filename) }
          : part,
      )
      .filter((part) => part.kind !== 'text' || part.text.length > 0);

    // Detras de la ultima imagen adjunta, o al principio si es la primera.
    let at = 0;
    cleaned.forEach((part, index) => {
      if (isAttached(part)) at = index + 1;
    });

    target.parts = [...cleaned.slice(0, at), image, ...cleaned.slice(at)];
    this.partUpdates.push({ eventId: target.eventId, parts: target.parts });
  }

  /**
   * Anota un eslabon de la cadena de adjuntos, con tope.
   *
   * Solo sirve para el adjunto que venga inmediatamente despues, asi que
   * guardar los de toda una sesion no compra nada. Se descarta el mas viejo
   * —`Map` conserva el orden de insercion— y con eso el mapa no crece con el
   * archivo.
   */
  private rememberAttachment(attachmentId: string, rootId: string): void {
    this.attachmentRoots.set(attachmentId, rootId);
    if (this.attachmentRoots.size <= MAX_ATTACHMENT_LINKS) return;
    const oldest = this.attachmentRoots.keys().next();
    if (!oldest.done) this.attachmentRoots.delete(oldest.value);
  }

  /**
   * Medidor de contexto.
   *
   * La ultima peticion es `input + cache_read + cache_creation`: los tres son
   * contexto que el modelo tuvo que leer, este cacheado o no. Mostrar solo
   * `input_tokens` daria cifras absurdamente bajas, porque con cache casi todo
   * el contexto viaja como `cache_read`.
   */
  private accumulate(event: ConversationEvent): void {
    const usage = event.usage;
    if (usage === null || event.role !== 'assistant') return;

    const lastRequestTokens =
      usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    this.lastRawModel = event.model;
    const model = this.resolveModel(event.model);
    // Tres fuentes, de mas a menos confiable: la variante que dice el archivo,
    // la que usa la instalacion, y —si los tokens ya no entran— la evidencia.
    const fitted = fitWindowToObserved(contextWindowFor(model), lastRequestTokens);

    this.usage = {
      lastRequestTokens,
      lastOutputTokens: usage.outputTokens,
      lastModel: model,
      // null si no reconocemos el modelo. Nunca se inventa un limite.
      contextWindow: fitted.window,
      contextWindowEstimated: fitted.estimated,
      totalInputTokens: this.usage.totalInputTokens + usage.inputTokens,
      totalOutputTokens: this.usage.totalOutputTokens + usage.outputTokens,
      totalCacheReadTokens: this.usage.totalCacheReadTokens + usage.cacheReadInputTokens,
      assistantMessages: this.usage.assistantMessages + 1,
    };
  }

  /**
   * Id completo del modelo, con su sufijo de variante si lo podemos recuperar.
   *
   * Lo que trae la linea `assistant` viene siempre sin sufijo, asi que pasarlo
   * tal cual a la tabla de ventanas da 200k incluso en una sesion de 1M.
   */
  private resolveModel(rawModel: string | null): string | null {
    /*
      La configuracion se aplica al final, sobre lo que haya salido de las
      otras fuentes — incluida la del propio archivo.

      Y eso importa por un detalle del formato: **`modelUsage` de `cost-state`
      es un acumulado de la sesion**, no el modelo del turno. Una sesion que
      arranco en `opus[1m]` y despues cambio a `opus` sigue listando
      `claude-opus-5[1m]` en cada `cost-state` posterior, para siempre. Si esa
      rama saliera antes de mirar la configuracion —como salia—, volver a 200k
      no movia la barra nunca.
    */
    const fromSession = this.sessionVariants.resolve(rawModel);
    const resolved =
      fromSession !== null && fromSession !== rawModel
        ? fromSession
        : (this.installVariants?.resolve(rawModel) ?? rawModel);
    return this.applyConfiguredVariant(resolved);
  }

  /**
   * Ajusta la variante a la que declara la configuracion.
   *
   * Agrega el sufijo siempre que la configuracion lo declare, y lo **quita**
   * solo cuando esta sesion vio un `/model` (ver `configuredDecides`): ahi el
   * alias sin sufijo es una eleccion del usuario que la CLI confirmo, no un
   * nombre al que le falta el dato.
   *
   * En las dos direcciones se exige que la familia coincida: lo que el usuario
   * configuro para sonnet no describe a un opus.
   */
  private applyConfiguredVariant(model: string | null): string | null {
    if (model === null || this.configuredAlias === null) return model;

    const family = modelFamilyOf(model);
    if (family === null || family !== modelFamilyOf(this.configuredAlias)) return model;

    const configuredLong = this.configuredAlias !== modelVariantBase(this.configuredAlias);
    const observedLong = model !== modelVariantBase(model);

    if (configuredLong && !observedLong) {
      return `${model}${this.configuredAlias.slice(this.configuredAlias.indexOf('['))}`;
    }
    if (!configuredLong && observedLong && this.configuredDecides) {
      return modelVariantBase(model);
    }
    return model;
  }
}
