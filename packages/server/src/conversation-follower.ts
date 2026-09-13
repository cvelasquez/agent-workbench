/**
 * Seguimiento incremental de un archivo de sesion.
 *
 * Guarda el offset en bytes y lee **solo lo nuevo**. Releer el archivo entero
 * en cada cambio no es una optimizacion prematura que nos ahorramos: la CLI
 * escribe en el JSONL en cada turno y hay sesiones de 2,9 MB, asi que releerlas
 * completas cada vez es releer megabytes por cada linea que se agrega.
 *
 * Dos detalles que hacen la diferencia entre que esto funcione y que se rompa
 * cada tanto de forma dificil de reproducir:
 *
 *  - **El resto parcial se guarda como `Buffer`, no como string.** Una lectura
 *    corta en cualquier byte, y decodificar UTF-8 a mitad de un caracter deja
 *    un `�` en el medio del texto. Solo se decodifican lineas completas.
 *  - **Si el archivo encoge, se reinicia.** Significa que lo reemplazaron o lo
 *    truncaron; seguir leyendo desde el offset viejo devolveria basura.
 */

import { open, stat } from 'node:fs/promises';
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
  toPlanFileName,
  toConversationEvent,
  toTurnDuration,
  toUserImageAttachment,
  type UserImageAttachment,
} from './jsonl-events.js';
import { parseJsonlLine } from './jsonl-reader.js';
import { ModelVariantRegistry } from './model-variants.js';

/** Bloque de lectura. Las lineas largas (hasta 290 KB) igual se arman a mano. */
const READ_CHUNK_BYTES = 256 * 1024;

/**
 * Tope de eventos en memoria por sesion.
 *
 * Una sesion larga tiene ~10.000 lineas. Con el recorte por parte cada evento
 * pesa poco, pero el tope evita que una sesion enorme y una app abierta todo el
 * dia terminen en cientos de MB. Se descartan los mas viejos.
 */
const MAX_EVENTS = 4_000;

/**
 * Cuantos eslabones de la cadena de adjuntos se recuerdan.
 *
 * Cada entrada solo sirve para el adjunto que venga justo despues, asi que con
 * cien alcanza de sobra: en la instalacion entera hay 39 adjuntos de imagen.
 */
const MAX_ATTACHMENT_LINKS = 100;

const NEWLINE = 0x0a;

/** Cuanto tardo un turno que ya se habia entregado. */
export interface TurnUpdate {
  eventId: string;
  durationMs: number;
}

/**
 * Las partes de un evento que ya se habia entregado, rehechas.
 *
 * Mismo caso que `TurnUpdate` y por el mismo motivo: la linea `attachment` con
 * la imagen llega **despues** del mensaje que la lleva. Casi siempre en la
 * linea inmediatamente siguiente —medido: 17 de 17— y por lo tanto en la misma
 * lectura, pero un poll puede caer justo en el medio.
 */
export interface PartsUpdate {
  eventId: string;
  parts: ConversationPart[];
}

export interface PollResult {
  /** true si el archivo se reemplazo: el cliente tiene que rehacer su vista. */
  reset: boolean;
  added: ConversationEvent[];
  /**
   * Duraciones de turnos ya entregados.
   *
   * Van aparte de `added` porque llegan **despues** del mensaje al que
   * pertenecen: la CLI escribe la duracion en la linea siguiente, que casi
   * siempre cae en la misma lectura, pero no siempre. Reenviar el evento entero
   * obligaria al cliente a deduplicar; una actualizacion suelta se aplica y
   * ya.
   */
  turns: TurnUpdate[];
  /**
   * Planes que esta conversacion nombro y no estaban antes.
   *
   * Van aparte de los eventos porque no son una tarjeta del hilo: el plan se ve
   * en su propia solapa, y lo que lo anuncia en el JSONL —una linea `plan_mode`
   * o un `Write` a la carpeta de planes— ya se dibuja como lo que es.
   */
  plans: string[];
  /** Eventos ya entregados a los que se les agrego una imagen adjunta. */
  parts: PartsUpdate[];
}

export class ConversationFollower {
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);
  private lineNumber = 0;
  private events: ConversationEvent[] = [];
  /** Eventos viejos que se descartaron por el tope. Solo para saber si hay mas. */
  private dropped = 0;
  private usage: ContextUsage = { ...EMPTY_CONTEXT_USAGE };
  private state: ConversationState = 'waiting';
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

  /**
   * Lo que sabemos de la instalacion, para las sesiones que todavia no
   * escribieron ningun `cost-state` — que son casi todas mientras se trabaja.
   */
  constructor(
    readonly filePath: string,
    private readonly installVariants?: ModelVariantRegistry,
  ) {}

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
    return this.state;
  }

  /** El modo de permiso que dice el archivo, o null si todavia no lo dijo. */
  getPermissionMode(): PermissionMode | null {
    return this.permissionMode;
  }

  getUsage(): ContextUsage {
    return this.usage;
  }

  /** Ultimos `limit` eventos, que es lo que se quiere ver al abrir el panel. */
  getTail(limit: number): { events: ConversationEvent[]; hasMore: boolean } {
    const events = this.events.slice(-limit);
    return {
      events,
      hasMore: this.events.length > events.length || this.dropped > 0,
    };
  }

  /** Tramo anterior a un evento ya entregado. Vacio si ese id ya no esta. */
  getPageBefore(
    beforeEventId: string,
    limit: number,
  ): { events: ConversationEvent[]; hasMore: boolean } {
    const index = this.events.findIndex((event) => event.eventId === beforeEventId);
    if (index <= 0) return { events: [], hasMore: false };

    const start = Math.max(0, index - limit);
    return {
      events: this.events.slice(start, index),
      hasMore: start > 0 || this.dropped > 0,
    };
  }

  /**
   * Lee lo que haya de nuevo.
   *
   * No lanza si el archivo no existe: entre que se abre una pestana y el
   * usuario manda el primer mensaje, no existe, y eso es lo normal.
   */
  async poll(): Promise<PollResult> {
    let size: number;
    try {
      const info = await stat(this.filePath);
      size = info.size;
    } catch {
      // Todavia no existe, o lo borraron. Si teniamos algo, se descarta.
      if (this.events.length > 0 || this.offset > 0) {
        this.reset();
        this.state = 'waiting';
        return { reset: true, added: [], turns: [], plans: [], parts: [] };
      }
      this.state = 'waiting';
      return { reset: false, added: [], turns: [], plans: [], parts: [] };
    }

    let didReset = false;
    if (size < this.offset) {
      // Reemplazado o truncado: lo que sabiamos ya no vale.
      this.reset();
      didReset = true;
    }

    this.state = 'live';
    if (size === this.offset) {
      return { reset: didReset, added: [], turns: [], plans: [], parts: [] };
    }

    this.turns = [];
    this.partUpdates = [];
    this.freshPlans = [];
    const added = await this.readFrom(size);
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
    return { reset: didReset, added, turns, plans, parts };
  }

  private reset(): void {
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.lineNumber = 0;
    this.events = [];
    this.dropped = 0;
    this.usage = { ...EMPTY_CONTEXT_USAGE };
    this.permissionMode = null;
    this.attachmentRoots.clear();
    this.planFiles = [];
  }

  private async readFrom(size: number): Promise<ConversationEvent[]> {
    const added: ConversationEvent[] = [];
    const handle = await open(this.filePath, 'r');

    try {
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);

      while (this.offset < size) {
        const toRead = Math.min(READ_CHUNK_BYTES, size - this.offset);
        const { bytesRead } = await handle.read(buffer, 0, toRead, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;

        // Copia explicita: `buffer` se reusa en la vuelta siguiente.
        const combined = Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]);

        let start = 0;
        let newlineIndex = combined.indexOf(NEWLINE, start);
        while (newlineIndex !== -1) {
          const line = combined.subarray(start, newlineIndex).toString('utf8');
          start = newlineIndex + 1;
          const event = this.consumeLine(line);
          if (event !== null) added.push(event);
          newlineIndex = combined.indexOf(NEWLINE, start);
        }

        // El resto queda pendiente hasta que llegue su salto de linea.
        this.pending = Buffer.from(combined.subarray(start));
      }
    } finally {
      await handle.close();
    }

    return added;
  }

  /** true si la linea es la invocacion de `/model` que la CLI guarda. */
  private mentionsModelCommand(record: Record<string, unknown>): boolean {
    const message = record['message'];
    if (typeof message !== 'object' || message === null) return false;
    const content = (message as Record<string, unknown>)['content'];
    return typeof content === 'string' && content.includes('<command-name>/model</command-name>');
  }

  /** Procesa una linea completa. Nunca lanza: el esquema cambia entre versiones. */
  private consumeLine(rawLine: string): ConversationEvent | null {
    const line = rawLine.trim();
    this.lineNumber += 1;
    if (line.length === 0) return null;

    const record = parseJsonlLine(line);
    if (record === null) return null;

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
      Un plan del modo plan. Tampoco es una tarjeta: el plan se lee en su
      solapa. La linea que lo nombra sigue su camino normal —puede ser un
      `Write`, que si es una tarjeta— asi que esto no devuelve.
    */
    const planFile = toPlanFileName(record);
    if (planFile !== null && !this.planFiles.includes(planFile)) {
      this.planFiles.push(planFile);
      this.freshPlans.push(planFile);
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
      const target = this.events.find((event) => event.eventId === turn.eventId);
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
      this.applyImageAttachment(attachment);
      return null;
    }

    const event = toConversationEvent(record, this.lineNumber);
    if (event === null) return null;

    this.accumulate(event);
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.shift();
      this.dropped += 1;
    }
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
   * Planes de esta sesion, en el orden en que la conversacion los nombro.
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
  private applyImageAttachment(attachment: UserImageAttachment): void {
    // El padre puede ser el mensaje o el adjunto anterior. En el segundo caso,
    // el mensaje es el que ya se anoto para ese eslabon.
    const rootId = this.attachmentRoots.get(attachment.eventId) ?? attachment.eventId;
    if (attachment.attachmentId.length > 0) {
      this.rememberAttachment(attachment.attachmentId, rootId);
    }

    const target = this.events.find((event) => event.eventId === rootId);
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
