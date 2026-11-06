import type { PlanContent, SessionPlan } from '@agent-workbench/shared';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describePlans, readPlan } from '../claude-code/plans-store.js';

const PREFIX = 'codex-plan:';
const DOCUMENT_PREFIX = 'codex-doc:';
const MAX_TEXT = 16_000;
const MAX_CACHED_PLANS = 1024;
const MAX_CACHED_DOCUMENTS = 4096;
const cache = new Map<string, string>();
interface CodexDocumentLocation {
  target: { cwd: string; sessionId: string };
  projectRef: string;
  origin: 'project' | 'reference';
}
const documentCache = new Map<string, CodexDocumentLocation>();

function remember(text: string): string {
  const ref = PREFIX + createHash('sha256').update(text).digest('hex');
  cache.delete(ref);
  cache.set(ref, text);
  while (cache.size > MAX_CACHED_PLANS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return ref;
}

function limitText(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

export function proposedPlanRef(message: string): string | null {
  const match = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/.exec(message);
  const text = match?.[1]?.trim();
  return text ? remember(limitText(text)) : null;
}

/** La referencia identifica el texto en memoria sin exponerlo en el identificador. */
export function planRef(raw: string): string | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record['plan'])) return null;
    const lines: string[] = [];
    for (const item of record['plan']) {
      if (item === null || typeof item !== 'object') return null;
      const step = item as Record<string, unknown>;
      if (typeof step['step'] !== 'string' || !['pending', 'in_progress', 'completed'].includes(String(step['status']))) return null;
      const marker = step['status'] === 'completed' ? 'x' : ' ';
      const progress = step['status'] === 'in_progress' ? ' ⏳' : '';
      lines.push(`- [${marker}] ${step['step'].replace(/[\r\n]+/g, ' ')}${progress}`);
    }
    if (lines.length === 0) return null;
    const explanation = typeof record['explanation'] === 'string' ? record['explanation'] + '\n\n' : '';
    const text = limitText(explanation + lines.join('\n'));
    return remember(text);
  } catch {
    return null;
  }
}

function insideRoot(cwd: string, name: string): string | null {
  if (!cwd || !path.isAbsolute(cwd) || !name || name.includes('\0') || name.length > 2048) return null;
  // Codex CLI usa `/D:/...` para rutas de Windows en enlaces Markdown entre ángulos.
  if (process.platform === 'win32' && /^\/[a-zA-Z]:[\\/]/.test(name)) name = name.slice(1);
  // A foreign Windows absolute path must not be mistaken for a relative name on POSIX.
  if (path.win32.isAbsolute(name) && !path.isAbsolute(name)) return null;
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, name);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

function documentRef(cwd: string, sessionId: string, name: string, origin: 'project' | 'reference'): string | null {
  const relative = insideRoot(cwd, name);
  if (relative === null || !relative.toLowerCase().endsWith('.md') || sessionId.length === 0) return null;
  const target = { cwd: path.resolve(cwd), sessionId };
  const projectRef = `proj:${relative}`;
  const normalizedCwd = process.platform === 'win32' ? target.cwd.toLowerCase() : target.cwd;
  const key = `${sessionId}\0${normalizedCwd}\0${process.platform === 'win32' ? relative.toLowerCase() : relative}`;
  const ref = DOCUMENT_PREFIX + createHash('sha256').update(key).digest('hex');
  const previous = documentCache.get(ref);
  documentCache.delete(ref);
  documentCache.set(ref, {
    target,
    projectRef,
    // A later explicit write is stronger attribution than a Markdown link.
    origin: origin === 'project' || previous?.origin === undefined ? origin : previous.origin,
  });
  while (documentCache.size > MAX_CACHED_DOCUMENTS) {
    const oldest = documentCache.keys().next().value;
    if (oldest === undefined) break;
    documentCache.delete(oldest);
  }
  return ref;
}

function refsForPaths(paths: readonly string[], cwd: string, sessionId: string, origin: 'project' | 'reference'): string[] {
  const refs: string[] = [];
  for (const name of paths) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    const ref = documentRef(cwd, sessionId, name, origin);
    if (ref !== null && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

/** Markdown files explicitly added, updated, or moved by an apply_patch call. */
export function patchDocuments(patch: string, cwd: string, sessionId = ''): string[] {
  if (!cwd || patch.length > 64_000) return [];
  const paths: string[] = [];
  let current: string | null = null;
  for (const line of patch.split(/\r?\n/)) {
    const file = /^\*\*\* (?:Add|Update) File: (.+)$/.exec(line);
    if (file !== null) {
      current = (file[1] ?? '').trim();
      paths.push(current);
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move !== null && current !== null) {
      current = (move[1] ?? '').trim();
      paths.push(current);
      continue;
    }
    if (/^\*\*\* (?:Delete File|End Patch)/.test(line)) current = null;
  }
  return refsForPaths(paths, cwd, sessionId, 'project');
}

/** Extracts only explicit Markdown destinations from the shell write forms AWB recognizes. */
export function shellCommandDocuments(command: string, cwd: string, sessionId = ''): string[] {
  if (!cwd || command.length > 32_000 || sessionId.length === 0) return [];
  const paths: string[] = [];
  const patterns = [
    /\b(?:Set-Content|Add-Content|Out-File|New-Item)\b[^\r\n|;]*?-(?:LiteralPath|FilePath|Path)\s+("[^"]+"|'[^']+'|[^\s|;]+)/gi,
    /\btee\s+(?:-a\s+)?("[^"]+"|'[^']+'|[^\s|;]+)/gi,
    /(?:^|[|;&])\s*cat\s+(?:-[^\s]+\s+)*(?:>>?\s*)("[^"]+"|'[^']+'|[^\s|;]+)/gi,
    /\bMove-Item\b[^\r\n|;]*?-Destination\s+("[^"]+"|'[^']+'|[^\s|;]+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      const raw = (match[1] ?? '').replace(/^("|')|("|')$/g, '');
      if (raw.toLowerCase().endsWith('.md')) paths.push(raw);
    }
  }
  return refsForPaths(paths, cwd, sessionId, 'project');
}

/** Local inline Markdown links can identify documents written by opaque scripts. */
export function referencedMarkdownDocuments(message: string, cwd: string, sessionId: string): string[] {
  if (message.length > 64_000 || !cwd || !sessionId) return [];
  const paths: string[] = [];
  const link = /\[[^\]\r\n]{1,256}\]\(\s*(?:<([^>\r\n]+)>|((?:\\.|[^\s)])+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
  for (const match of message.matchAll(link)) {
    let destination = (match[1] ?? match[2] ?? '').replace(/\\([()\\])/g, '$1');
    try { destination = decodeURIComponent(destination); } catch { continue; }
    destination = destination.split(/[?#]/, 1)[0] ?? '';
    if (!destination.toLowerCase().endsWith('.md') || /^[a-z][a-z0-9+.-]*:/i.test(destination) && !/^[a-z]:[\\/]/i.test(destination)) continue;
    paths.push(destination);
  }
  return refsForPaths(paths, cwd, sessionId, 'reference');
}

function decodeDocument(ref: string): CodexDocumentLocation | null {
  if (!/^codex-doc:[a-f0-9]{64}$/.test(ref)) return null;
  return documentCache.get(ref) ?? null;
}

/** Verifies existence and containment before a candidate is published in Planes. */
export async function verifyCodexDocument(ref: string): Promise<boolean> {
  const location = decodeDocument(ref);
  if (location === null) return false;
  const [document] = await describePlans(location.target, [location.projectRef]);
  return document?.exists === true;
}

function decode(ref: string): string | null {
  if (!/^codex-plan:[a-f0-9]{64}$/.test(ref)) return null;
  return cache.get(ref) ?? null;
}

export async function describeCodexPlans(target: { cwd: string; sessionId: string }, refs: readonly string[]): Promise<SessionPlan[]> {
  const documents: SessionPlan[] = [];
  for (const ref of refs) {
    const location = decodeDocument(ref);
    if (location !== null) {
      const [document] = await describePlans(location.target, [location.projectRef]);
      if (document !== undefined) documents.push({ ...document, fileName: ref, origin: location.origin });
      continue;
    }
    if (ref.startsWith('proj:')) {
      const [document] = await describePlans(target, [ref]);
      if (document !== undefined) documents.push(document);
      continue;
    }
    const text = decode(ref);
    if (text !== null) documents.push({ fileName: ref, title: 'Plan', origin: 'project', path: '', absolutePath: '', exists: true, modifiedAt: 0, sizeBytes: Buffer.byteLength(text) });
  }
  return documents;
}

export async function readCodexPlan(target: { cwd: string; sessionId: string }, ref: string): Promise<PlanContent | null> {
  const location = decodeDocument(ref);
  if (location !== null) {
    const plan = await readPlan(location.target, location.projectRef);
    return plan === null ? null : { ...plan, fileName: ref };
  }
  if (ref.startsWith('proj:')) return readPlan(target, ref);
  const text = decode(ref);
  return text === null ? null : { fileName: ref, text, truncated: false };
}
