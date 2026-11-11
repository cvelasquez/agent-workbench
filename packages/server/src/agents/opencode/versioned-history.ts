import type { HistorySource, SessionFollower } from '../adapter.js';

/** El esquema se puede crear o migrar después de iniciar Workbench. */
export function versionedHistory(select: () => HistorySource, common: HistorySource): HistorySource {
  return {
    // Vigilar la ruta no necesita abrir SQLite, que puede estar ocupado.
    roots: () => common.roots(),
    list: () => select().list(),
    rootExists: () => common.rootExists!(),
    changedRefs: (file) => select().changedRefs(file),
    item: (ref) => select().item(ref),
    scan: (item) => select().scan(item),
    restored: (item, extra) => select().restored(item, extra),
    exists: (cwd, id) => select().exists(cwd, id),
    follow(target, options) {
      let source = select();
      let current = source.follow(target, options);
      let started = false;
      const follower: SessionFollower = {
        get label() { return current.label; },
        async start() { started = true; await current.start(); },
        async poll() {
          const next = select();
          if (next === source) return current.poll();
          await current.close?.();
          source = next;
          current = source.follow(target, options);
          if (started) await current.start();
          const result = await current.poll();
          // Una pestaña dormida puede haber empezado a leer antes de que
          // OpenCode 2 proyecte el historial de OpenCode 1 al despertar.
          return { ...result, reset: true };
        },
        getState: () => current.getState(),
        getUsage: () => current.getUsage(),
        getPermissionMode: () => current.getPermissionMode(),
        getTail: (limit) => current.getTail(limit),
        getPageBefore: (id, limit) => current.getPageBefore(id, limit),
        getPlanFiles: () => current.getPlanFiles(),
        readImage: (id, index, imageSource) => current.readImage(id, index, imageSource),
        noticeChange: (file) => current.noticeChange(file),
        hasOpenToolCall: (launchedAt) => current.hasOpenToolCall(launchedAt),
        queuedPrompts: (launchedAt) => current.queuedPrompts?.(launchedAt) ?? [],
        close: async () => { await current.close?.(); },
      };
      return follower;
    },
    wholeRead: true,
    plans: null,
    followPollMs: null,
  };
}
