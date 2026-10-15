import { create } from 'zustand';
import { api, type SavedSsh, type SshHost } from './api';
import { useApp } from './store';
import type { SshEntry } from './lib/ssh';
import { t } from './i18n';

/** An open SSH terminal tab. `gen` changes on "Reconnect" so a fresh session (new sid) replaces the ended one. */
export interface SshSession { key: string; entry: SshEntry; n: number; gen: number; closed: boolean }

interface SshStore {
  config: SshHost[];
  saved: SavedSsh[];
  loaded: boolean;
  sessions: SshSession[];
  active: string | null;
  load: () => Promise<void>;
  open: (e: SshEntry) => void;
  close: (key: string) => void;
  setActive: (key: string) => void;
  ended: (key: string) => void;
  reconnect: (key: string) => void;
  addSaved: (h: SavedSsh) => Promise<boolean>;
  removeSaved: (name: string) => void;
}

const toast = (msg: string, kind?: 'ok' | 'info' | 'err') => useApp.getState().toast(msg, kind);
const newKey = () => crypto.randomUUID().replace(/-/g, '');

export const useSsh = create<SshStore>()((set, get) => ({
  config: [], saved: [], loaded: false, sessions: [], active: null,

  load: async () => {
    const [config, saved] = await Promise.all([api.sshHosts().catch(() => [] as SshHost[]), api.sshSavedList().catch(() => [] as SavedSsh[])]);
    set({ config, saved, loaded: true });
  },

  open: (entry) => {
    const n = Math.max(0, ...get().sessions.filter((s) => s.entry.id === entry.id).map((s) => s.n)) + 1;
    const key = newKey();
    set((s) => ({ sessions: [...s.sessions, { key, entry, n, gen: 1, closed: false }], active: key }));
  },

  // Removing the tab unmounts its TerminalView, which closes the ssh process.
  close: (key) => set((s) => {
    const left = s.sessions.filter((x) => x.key !== key);
    const ix = s.sessions.findIndex((x) => x.key === key);
    const active = s.active === key ? (left[Math.min(ix, left.length - 1)]?.key ?? null) : s.active;
    return { sessions: left, active };
  }),

  setActive: (key) => set({ active: key }),
  ended: (key) => set((s) => ({ sessions: s.sessions.map((x) => (x.key === key ? { ...x, closed: true } : x)) })),
  reconnect: (key) => set((s) => ({ sessions: s.sessions.map((x) => (x.key === key ? { ...x, closed: false, gen: x.gen + 1 } : x)), active: key })),

  addSaved: async (h) => {
    try {
      await api.sshSavedAdd(h);
      set({ saved: await api.sshSavedList() });
      toast(t("Added SSH host {name}", { name: h.name }));
      return true;
    } catch (e) {
      toast((e as Error).message, 'err');
      return false;
    }
  },

  removeSaved: (name) => {
    useApp.getState().ask({
      title: t("Remove SSH host {name}?", { name }),
      body: t("Only removes it from the app. Open terminals of this host stay open."),
      yes: t("Remove"), danger: true,
      action: async () => {
        await api.sshSavedRemove(name).catch(() => {});
        set({ saved: await api.sshSavedList() });
      },
    });
  },
}));
