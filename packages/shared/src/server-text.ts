/**
 * Los textos que el servidor le manda a la web para mostrar (hito 34, §6.23).
 *
 * El servidor no arma frases: manda una clave y sus valores, y la web busca la
 * frase en su idioma, en `server.<clave>` de `web/src/i18n/locales/*.json`. El
 * servidor no sabe en que idioma esta cada ventana, y no lo necesita: dos
 * ventanas pueden tener idiomas distintos.
 *
 * `SERVER_TEXTS` es el contrato: que claves existen y que valores lleva cada
 * una. `check-i18n.mjs` comprueba que cada clave tenga su frase en todos los
 * idiomas con exactamente esos valores, y que no sobre ninguna `server.*`.
 *
 * Los detalles que vienen de afuera —la salida de git, un error del sistema
 * operativo— van como un valor, tal cual llegan. Un valor tambien puede ser
 * otro texto del servidor ("no se pudo consultar git: <el motivo>"), un nivel
 * de profundidad: la web arma los dos en su idioma.
 */

import { asRecord, asString } from './validation.js';

// --- La lista: cada clave, con los nombres de sus valores ---------------------

export const SERVER_TEXTS = {
  agentUnknown: [],
  answerInterrupted: [],
  answerInvalid: [],
  answerNoFreeText: [],
  answerNotPending: [],
  answerSendFailed: [],
  answersUnsupported: [],
  archiveOpenTab: [],
  attachmentEmpty: ['name'],
  attachmentExecutable: ['name'],
  attachmentSaveFailed: [],
  attachmentTooLarge: ['max', 'name', 'size'],
  badMessage: [],
  cliMissing: ['command', 'url'],
  cliNotFound: [],
  cliNotInstalled: ['label'],
  cliOpenFailed: [],
  continueFailed: [],
  continueHistoryMissing: [],
  continueNoFolder: [],
  continueNotInHistory: [],
  continueReadFailed: [],
  continueSameCli: [],
  continueTabFailed: [],
  continueTranscriptFailed: [],
  conversationNotFollowed: [],
  cwdMissing: ['cwd'],
  cwdNotDir: ['cwd'],
  diffBinaryUntracked: [],
  diffNewEmpty: [],
  diffNoStaged: [],
  diffNoUnstaged: [],
  diffReadFailed: [],
  dirReadFailed: [],
  dirSearchFailed: [],
  fileReadFailed: [],
  filesPerMessage: ['max'],
  gitCommandFailed: ['command'],
  gitMissing: [],
  gitNotFound: [],
  gitNotRepo: [],
  gitRunFailed: [],
  gitStatusUnknown: [],
  gitUnexpected: ['command'],
  handoffEmpty: [],
  handoffNoTranscript: [],
  imageEmpty: [],
  imageTooLarge: ['max', 'size'],
  imageTypeUnsupported: ['type'],
  imageUnknownFormat: [],
  imagesPerMessage: ['max'],
  imagesUnsupported: [],
  memoryAppeared: ['file'],
  memoryBrokenBlock: ['file'],
  memoryChooseFile: [],
  memoryGitFailed: ['detail'],
  memoryHardLinks: ['file'],
  memoryLinkOutside: ['path'],
  memoryNotAFile: ['label'],
  memoryNotInstalled: [],
  memoryNotUtf8: ['file'],
  memoryNoteClaude: [],
  memoryNoteGone: [],
  memoryNoteHardLink: ['path'],
  memoryNoteHardLinkCmd: ['path'],
  memoryNoteName: [],
  memoryNoteOpenCode: [],
  memorySameFile: ['file', 'other'],
  memoryViaEncoding: ['file'],
  memoryViaFallback: [],
  memoryViaFile: ['file'],
  memoryViaNoBlock: ['file'],
  memoryViaNoBlockEither: [],
  memoryViaNoFolder: [],
  memoryViaNoIndex: [],
  memoryViaOutside: ['file'],
  modePendingConfirmation: [],
  modeUnreachable: ['key'],
  modesUnsupported: [],
  noteCliNotStarted: [],
  noteEmpty: [],
  noteExists: [],
  noteGone: [],
  noteIdInvalid: [],
  noteImageFailed: [],
  noteImagesMax: ['max'],
  noteImagesUnsupported: [],
  noteInterrupted: [],
  noteNoAgent: [],
  noteNoReadySignal: [],
  noteSaveFailed: [],
  noteTooLong: ['max'],
  notesMax: ['max'],
  openToolSubmit: ['label'],
  operationFailed: ['detail'],
  pasteImageFailed: [],
  pathMissing: [],
  pathNotRelative: [],
  pathNullByte: [],
  pathOpenFailed: [],
  pathOutside: [],
  pendingSubmitAnswer: ['label'],
  pendingSubmitPermission: ['label'],
  pickerCliFolder: [],
  pickerClosed: [],
  pickerCreateFailed: [],
  pickerFolderExists: [],
  pickerListFailed: [],
  pickerNameChars: [],
  pickerNameInvalid: [],
  pickerNoProjectsHere: [],
  pickerNotListed: [],
  pickerRootMissing: [],
  pickerTooMany: [],
  planReadFailed: [],
  raw: ['text'],
  relaunchCloseFailed: [],
  searchFailed: [],
  shellNotFound: [],
  submitInterrupted: [],
  submitStoppedTool: ['label'],
  submitStoppedToolNoLabel: [],
  submitStoppedWaiting: ['label'],
  submitStoppedWaitingNoLabel: [],
  tabClosedWhileOpening: [],
  tabDirGone: [],
  tabOpenFailed: [],
  terminalAsleep: [],
  terminalGone: [],
  terminalOpenFailed: [],
  tooManyTabs: ['max'],
  vaultBusyMeasuring: [],
  vaultBusyMoving: [],
  vaultBusyWriting: [],
  vaultCannotWrite: [],
  vaultCurrentInsideTarget: [],
  vaultDiskFull: ['detail'],
  vaultFailed: [],
  vaultIndexNotReady: [],
  vaultMeasureFirst: [],
  vaultMemoryFailed: ['cwd', 'detail'],
  vaultMoveFailed: ['detail'],
  vaultMoving: [],
  vaultNoCopyYet: [],
  vaultNotLoaded: [],
  vaultProjectGone: [],
  vaultReasonNewerFormat: [],
  vaultReasonOriginMissing: [],
  vaultReasonUnsafeId: [],
  vaultSessionFailed: ['agent', 'detail', 'session'],
  vaultSessionMissing: [],
  vaultTargetCliFolder: [],
  vaultTargetInsideCurrent: [],
  vaultTargetNotAbsolute: [],
  waitingSubmit: ['label'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

// --- Fin de la lista ----------------------------------------------------------

export type ServerTextKey = keyof typeof SERVER_TEXTS;

/**
 * Un texto del servidor tal como viaja. La clave es `string` y no
 * `ServerTextKey`: un servidor mas nuevo puede mandar una que esta pagina no
 * conoce, y la web la muestra como puede en vez de perder el aviso.
 */
export interface ServerText {
  key: string;
  params?: ServerTextParams;
}

export type ServerTextParam = string | number | ServerText;

export type ServerTextParams = Readonly<Record<string, ServerTextParam>>;

type ParamNames<K extends ServerTextKey> = (typeof SERVER_TEXTS)[K][number];

/**
 * Arma un texto con una clave de la lista y exactamente sus valores. El tipo
 * no deja pasar una clave que no esta ni olvidar un valor.
 */
export function serverText<K extends ServerTextKey>(
  key: K,
  ...params: [ParamNames<K>] extends [never] ? [] : [Readonly<Record<ParamNames<K>, ServerTextParam>>]
): ServerText {
  const [values] = params;
  return values === undefined ? { key } : { key, params: values };
}

export function isServerTextKey(key: string): key is ServerTextKey {
  return Object.prototype.hasOwnProperty.call(SERVER_TEXTS, key);
}

/** Lee un texto del protocolo, o null si no tiene la forma. */
export function parseServerText(value: unknown, depth = 0): ServerText | null {
  const record = asRecord(value);
  if (record === null) return null;
  const key = asString(record['key']);
  if (key === null || key.length === 0) return null;
  const rawParams = record['params'];
  if (rawParams === undefined) return { key };
  const paramsRecord = asRecord(rawParams);
  if (paramsRecord === null) return null;
  const params: Record<string, ServerTextParam> = {};
  for (const [name, param] of Object.entries(paramsRecord)) {
    if (typeof param === 'string' || (typeof param === 'number' && Number.isFinite(param))) {
      params[name] = param;
      continue;
    }
    // Un texto dentro de otro, y nada mas hondo: no hace falta, y asi un
    // mensaje no puede anidar sin fin.
    const nested = depth === 0 ? parseServerText(param, depth + 1) : null;
    if (nested === null) return null;
    params[name] = nested;
  }
  return { key, params };
}

/** Lee una lista de textos, o null si alguno no tiene la forma. */
export function parseServerTexts(value: unknown): ServerText[] | null {
  if (!Array.isArray(value)) return null;
  const texts: ServerText[] = [];
  for (const item of value) {
    const text = parseServerText(item);
    if (text === null) return null;
    texts.push(text);
  }
  return texts;
}

/**
 * Un error cuyo texto para el usuario es un `ServerText`. El `message` es la
 * clave: sirve para los registros de la consola, que no se traducen.
 */
export class ServerTextError extends Error {
  readonly text: ServerText;

  constructor(text: ServerText, options?: ErrorOptions) {
    super(text.key, options);
    this.text = text;
    this.name = new.target.name;
  }
}
