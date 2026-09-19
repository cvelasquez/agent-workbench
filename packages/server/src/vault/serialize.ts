/**
 * Una sesion de la copia, armada en memoria. Puro: no toca el disco.
 *
 * El archivo es una cabecera, los eventos en el orden del seguidor y los
 * documentos, una linea por objeto (`shared/src/vault.ts`). Lo que sale de aca
 * lo escribe `write.ts` y lo mide la pasada en seco sin escribirlo, asi que las
 * dos cuentas son la misma por construccion.
 *
 * Las imagenes van en binario al lado, con el nombre del hash de sus bytes: dos
 * capturas iguales en la misma sesion son un solo archivo, y un asset que ya
 * esta en disco no se vuelve a escribir.
 */

import { createHash } from 'node:crypto';
import {
  VAULT_ASSET_NAME_PATTERN,
  VAULT_FORMAT,
  parseVaultBodyLine,
  parseVaultHeader,
  type ContextUsage,
  type ConversationEvent,
  type ConversationImageSource,
  type SessionAgentId,
  type SessionTitleSource,
  type VaultDocumentLine,
  type VaultEventLine,
  type VaultHeader,
  type VaultImageRef,
  type VaultSource,
} from '@agent-workbench/shared';
import { detectImageFormat } from '../image-signature.js';

/**
 * La identidad de una imagen dentro de su sesion, sin inventar ningun id: el
 * evento, la forma (`content` o `attachment`) y la posicion en esa forma.
 */
export function imageKey(eventId: string, source: ConversationImageSource, index: number): string {
  return `${eventId}|${source}|${index}`;
}

/**
 * `<32 hex del sha256>.<ext>`. La extension la deciden los bytes, no el
 * `mediaType` que declaro la CLI: es la misma regla que el pegado y las notas
 * (`image-signature.ts`). Una firma que no se reconoce es `bin`.
 */
export function assetName(bytes: Buffer): string {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  return `${hash}.${detectImageFormat(bytes)?.ext ?? 'bin'}`;
}

/**
 * Lo que se sabe de una imagen al serializar.
 *
 *  - `loaded`: se leyo recien; sus bytes van a `assets`.
 *  - `reused`: ya estaba en la copia anterior de esta sesion y su asset sigue
 *    en disco. No se leyo, y por eso no hay bytes (C5).
 *
 * Una imagen sin entrada en el mapa no se pudo leer: queda con `asset: null`.
 */
export type VaultImageInput =
  | { kind: 'loaded'; data: Buffer }
  | { kind: 'reused'; asset: string; bytes: number };

export interface VaultHeaderInput {
  agent: SessionAgentId;
  sessionId: string;
  /** `''` si no se sabe. */
  cwd: string;
  /**
   * El agrupador cuando `cwd` es `''` (Gemini CLI sin carpeta casada). Con
   * `cwd`, o sin agrupador, es `vault:<agent>:<sessionId>`.
   */
  group?: string | null;
  title: string;
  titleSource: SessionTitleSource;
  createdAt: number | null;
  updatedAt: number;
  cliVersionAtCopy: string | null;
  partial: boolean;
  stepCount: number | null;
  usage: ContextUsage | null;
  source: VaultSource;
  writtenAt: number;
}

export interface VaultHeaderCounts {
  eventCount: number;
  documentCount: number;
  /** Assets distintos que la sesion nombra (leidos o reusados). */
  imageCount: number;
}

/**
 * La cabecera, validada con el mismo parser que la va a leer.
 *
 * Lanza si no pasaria: una cabecera que el catalogo no puede leer es una sesion
 * que se escribe y no aparece nunca, y eso tiene que fallar al escribir, no el
 * dia que alguien la busca.
 */
export function buildHeader(input: VaultHeaderInput & VaultHeaderCounts): VaultHeader {
  const ownGroup = `vault:${input.agent}:${input.sessionId}`;
  const group = input.cwd.length > 0 || input.group === undefined || input.group === null || input.group.length === 0
    ? ownGroup
    : input.group;

  const header: VaultHeader = {
    kind: 'header',
    format: VAULT_FORMAT,
    agent: input.agent,
    sessionId: input.sessionId,
    cwd: input.cwd,
    group,
    title: input.title,
    titleSource: input.titleSource,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    cliVersionAtCopy: input.cliVersionAtCopy,
    partial: input.partial,
    stepCount: input.stepCount,
    usage: input.usage,
    eventCount: input.eventCount,
    documentCount: input.documentCount,
    imageCount: input.imageCount,
    source: input.source,
    writtenAt: input.writtenAt,
  };

  if (parseVaultHeader(JSON.parse(JSON.stringify(header))) === null) {
    throw new Error(`The header of ${input.agent}/${input.sessionId} couldn't be read back`);
  }
  return header;
}

export interface SerializeSessionInput {
  header: VaultHeaderInput;
  events: readonly ConversationEvent[];
  /** Por `imageKey`. Ausente: ninguna imagen se pudo leer. */
  images?: ReadonlyMap<string, VaultImageInput>;
  documents?: readonly VaultDocumentLine[];
}

export interface SerializedSession {
  header: VaultHeader;
  /** El `.jsonl` entero, con su salto de linea final. */
  text: string;
  /** Los assets leidos en esta serializacion, por nombre. No incluye los reusados. */
  assets: Map<string, Buffer>;
}

function imageRefsOf(
  event: ConversationEvent,
  images: ReadonlyMap<string, VaultImageInput>,
  assets: Map<string, Buffer>,
  named: Set<string>,
): VaultImageRef[] {
  const refs: VaultImageRef[] = [];
  for (const part of event.parts) {
    if (part.kind !== 'image') continue;
    const input = images.get(imageKey(event.eventId, part.source, part.index));
    let asset: string | null = null;
    let bytes = 0;
    if (input?.kind === 'loaded') {
      asset = assetName(input.data);
      bytes = input.data.length;
      if (!assets.has(asset)) assets.set(asset, input.data);
    } else if (input?.kind === 'reused' && VAULT_ASSET_NAME_PATTERN.test(input.asset)) {
      asset = input.asset;
      bytes = input.bytes;
    }
    if (asset !== null) named.add(asset);
    refs.push({ index: part.index, source: part.source, mediaType: part.mediaType, asset, bytes });
  }
  return refs;
}

/**
 * La sesion entera como texto y sus assets.
 *
 * Los documentos se validan con el parser del cuerpo por lo mismo que la
 * cabecera: un nombre con carpeta se descartaria al leer, y perder un documento
 * rescatado en silencio es justo lo que la copia existe para evitar. Los
 * eventos no: salen del seguidor, que ya entrega la forma de `shared`, y
 * validarlos uno por uno en una sesion de 20 MB cuesta mas que lo que protege.
 */
export function serializeSession(input: SerializeSessionInput): SerializedSession {
  const images = input.images ?? new Map<string, VaultImageInput>();
  const documents = input.documents ?? [];
  const assets = new Map<string, Buffer>();
  const named = new Set<string>();

  const bodyLines: string[] = [];
  for (const event of input.events) {
    const line: VaultEventLine = { kind: 'event', event, images: imageRefsOf(event, images, assets, named) };
    bodyLines.push(JSON.stringify(line));
  }
  for (const document of documents) {
    const line: VaultDocumentLine = {
      kind: 'document',
      origin: 'agent-document',
      name: document.name,
      modifiedAt: document.modifiedAt,
      text: document.text,
      truncated: document.truncated,
    };
    if (parseVaultBodyLine(line) === null) {
      throw new Error(`A document that couldn't be read back: ${JSON.stringify(document.name)}`);
    }
    bodyLines.push(JSON.stringify(line));
  }

  const header = buildHeader({
    ...input.header,
    eventCount: input.events.length,
    documentCount: documents.length,
    imageCount: named.size,
  });

  return { header, text: `${[JSON.stringify(header), ...bodyLines].join('\n')}\n`, assets };
}
