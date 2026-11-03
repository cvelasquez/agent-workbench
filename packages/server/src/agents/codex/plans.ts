import type { PlanContent, SessionPlan } from '@agent-workbench/shared';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describePlans, readPlan } from '../claude-code/plans-store.js';

const PREFIX = 'codex-plan:';
const MAX_TEXT = 16_000;
const MAX_CACHED_PLANS = 1024;
const cache = new Map<string, string>();

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

/** Solo documentos creados en el proyecto por un parche de esta conversacion. */
export function patchDocuments(patch: string, cwd: string): string[] {
  if (!cwd) return [];
  const refs: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = /^\*\*\* Add File: (.+)$/.exec(line);
    if (match === null) continue;
    const name = match[1] ?? '';
    if (!name.toLowerCase().endsWith('.md') || name.includes('\0')) continue;
    const relative = path.relative(cwd, path.resolve(cwd, name));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const ref = `proj:${relative.split(path.sep).join('/')}`;
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

function decode(ref: string): string | null {
  if (!/^codex-plan:[a-f0-9]{64}$/.test(ref)) return null;
  return cache.get(ref) ?? null;
}

export async function describeCodexPlans(target: { cwd: string; sessionId: string }, refs: readonly string[]): Promise<SessionPlan[]> {
  const documents = await describePlans(target, refs.filter((ref) => ref.startsWith('proj:')));
  return [...documents, ...refs.flatMap((ref) => {
    const text = decode(ref);
    return text === null ? [] : [{ fileName: ref, title: 'Plan', origin: 'project' as const, path: '', absolutePath: '', exists: true, modifiedAt: 0, sizeBytes: Buffer.byteLength(text) }];
  })];
}

export async function readCodexPlan(target: { cwd: string; sessionId: string }, ref: string): Promise<PlanContent | null> {
  if (ref.startsWith('proj:')) return readPlan(target, ref);
  const text = decode(ref);
  return text === null ? null : { fileName: ref, text, truncated: false };
}
