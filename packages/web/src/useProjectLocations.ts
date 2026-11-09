/**
 * Ubicar un proyecto que se movio de carpeta (hito 56, §13.14), del lado del
 * navegador.
 *
 * Los pasos son del usuario y los decide el servidor: aca se lleva la cuenta de
 * en cual esta esta ventana, y no se adivina nada. **Ningun pedido nombra una
 * ruta** (CLAUDE.md 2.4): el proyecto va por su `key`, la carpeta nueva es donde
 * quedo parado el selector del servidor, y confirmar manda el `previewId` con
 * que el servidor guardo esa carpeta.
 *
 *   idle -> choosing        "Ubicar carpeta…" abre el selector de carpetas
 *   choosing -> previewing  se eligio una carpeta: se pide la vista previa
 *   previewing -> ready     llego lo que se asociaria, con lo que bloquea
 *   ready -> saving         "Usar esta carpeta"
 *   saving -> idle          guardado: la barra nueva llega a todos por `index.projects`
 *   previewing|saving -> failed   el servidor lo rechazo; el texto es suyo
 *
 * Quitar una ubicacion no tiene pasos: un pedido y su respuesta. Su fallo se
 * dice aparte (`removeProblem`), en la barra, porque no hay dialogo abierto.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectLocationPreview, ProjectSummary, ServerMessage } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import { serverTextMessage } from './i18n/server-text.js';

export type LocationStep =
  | { kind: 'idle' }
  /** El selector de carpetas esta abierto (lo dibuja `App`). */
  | { kind: 'choosing'; project: ProjectSummary }
  | { kind: 'previewing'; project: ProjectSummary }
  | { kind: 'ready'; project: ProjectSummary; preview: ProjectLocationPreview }
  | { kind: 'saving'; project: ProjectSummary; preview: ProjectLocationPreview }
  | { kind: 'failed'; project: ProjectSummary; problem: string };

export interface ProjectLocationsApi {
  step: LocationStep;
  /** Ubicaciones quitandose: el pedido salio y la respuesta no llego. */
  removing: ReadonlySet<string>;
  /** Lo ultimo que fallo al quitar, con el texto del servidor. */
  removeProblem: string | null;
  /** Abre el selector para ubicar (o cambiar la ubicacion de) un proyecto. */
  begin: (project: ProjectSummary) => void;
  /**
   * Eligio la carpeta donde esta parado ese selector. Se llama **antes** de
   * cerrarlo: el servidor lee la carpeta del selector abierto.
   */
  choose: (pickerId: string) => void;
  /** "Usar esta carpeta": el servidor rehace la vista previa con el disco de ahora y guarda. */
  confirm: () => void;
  /** Vuelve a abrir el selector, con el mismo proyecto. */
  chooseAnother: () => void;
  /** Cierra todo sin guardar nada. */
  cancel: () => void;
  /** Quita las ubicaciones del proyecto: el historial queda donde estaba. */
  remove: (project: ProjectSummary) => void;
  dismissRemoveProblem: () => void;
}

const IDLE: LocationStep = { kind: 'idle' };
const NONE: ReadonlySet<string> = new Set();

export function useProjectLocations(connection: AgentConnection): ProjectLocationsApi {
  const [step, setStep] = useState<LocationStep>(IDLE);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(NONE);
  const [removeProblem, setRemoveProblem] = useState<string | null>(null);
  /** El pedido de vista previa o de guardar que esta en viaje: su respuesta lo reconoce por el `requestId`. */
  const inFlight = useRef<string | null>(null);
  /** Los pedidos de quitar en viaje, con el proyecto de cada uno. */
  const removals = useRef(new Map<string, string>());
  const stepRef = useRef<LocationStep>(IDLE);
  stepRef.current = step;

  useEffect(() => {
    const offMessage = connection.onMessage((message: ServerMessage) => {
      switch (message.type) {
        case 'location.previewed':
          if (inFlight.current !== message.requestId) break;
          inFlight.current = null;
          setStep((current) =>
            current.kind === 'previewing' ? { kind: 'ready', project: current.project, preview: message.preview } : current,
          );
          break;

        case 'location.applied':
          if (inFlight.current !== message.requestId) break;
          inFlight.current = null;
          setStep(IDLE);
          break;

        case 'location.removed': {
          const projectKey = removals.current.get(message.requestId);
          if (projectKey === undefined) break;
          removals.current.delete(message.requestId);
          setRemoving((current) => {
            if (!current.has(projectKey)) return current;
            const next = new Set(current);
            next.delete(projectKey);
            return next;
          });
          break;
        }

        case 'error': {
          if (message.code !== 'location-failed') break;
          if (message.detail !== undefined) console.error('[servidor]', message.detail);
          const text = serverTextMessage(message.text);
          if (message.requestId !== undefined && message.requestId === inFlight.current) {
            inFlight.current = null;
            setStep((current) =>
              current.kind === 'previewing' || current.kind === 'saving' ? { kind: 'failed', project: current.project, problem: text } : current,
            );
            break;
          }
          const projectKey = message.requestId === undefined ? undefined : removals.current.get(message.requestId);
          if (projectKey !== undefined && message.requestId !== undefined) {
            removals.current.delete(message.requestId);
            setRemoving((current) => {
              const next = new Set(current);
              next.delete(projectKey);
              return next;
            });
            setRemoveProblem(text);
          }
          break;
        }

        default:
          break;
      }
    });
    // Lo que estaba en viaje se perdio con el socket, y la vista previa guardada en el servidor tambien.
    const offReopen = connection.onReopen(() => {
      inFlight.current = null;
      removals.current.clear();
      setRemoving(NONE);
      setStep((current) => (current.kind === 'previewing' || current.kind === 'saving' || current.kind === 'ready' ? IDLE : current));
    });
    return () => {
      offMessage();
      offReopen();
    };
  }, [connection]);

  const begin = useCallback((project: ProjectSummary) => {
    setRemoveProblem(null);
    inFlight.current = null;
    setStep({ kind: 'choosing', project });
  }, []);

  const choose = useCallback(
    (pickerId: string) => {
      const current = stepRef.current;
      if (current.kind !== 'choosing') return;
      const requestId = crypto.randomUUID();
      inFlight.current = requestId;
      setStep({ kind: 'previewing', project: current.project });
      connection.send({ type: 'location.preview', requestId, projectKey: current.project.key, pickerId });
    },
    [connection],
  );

  const confirm = useCallback(() => {
    const current = stepRef.current;
    if (current.kind !== 'ready') return;
    const requestId = crypto.randomUUID();
    inFlight.current = requestId;
    setStep({ kind: 'saving', project: current.project, preview: current.preview });
    connection.send({ type: 'location.apply', requestId, previewId: current.preview.previewId });
  }, [connection]);

  const chooseAnother = useCallback(() => {
    const current = stepRef.current;
    if (current.kind === 'ready' || current.kind === 'failed') setStep({ kind: 'choosing', project: current.project });
  }, []);

  const cancel = useCallback(() => {
    inFlight.current = null;
    setStep(IDLE);
  }, []);

  const remove = useCallback(
    (project: ProjectSummary) => {
      const requestId = crypto.randomUUID();
      setRemoveProblem(null);
      removals.current.set(requestId, project.key);
      setRemoving((current) => new Set(current).add(project.key));
      connection.send({ type: 'location.remove', requestId, projectKey: project.key });
    },
    [connection],
  );

  const dismissRemoveProblem = useCallback(() => setRemoveProblem(null), []);

  return { step, removing, removeProblem, begin, choose, confirm, chooseAnother, cancel, remove, dismissRemoveProblem };
}
