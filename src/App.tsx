import { useEffect, useRef } from 'react';
import { homeDir } from '@tauri-apps/api/path';
import { inTauri } from './api';
import { useApp } from './store';
import { setHome } from './lib/ui';
import { EngineBanner, Header, Sidebar } from './components/Shell';
import { Toasts } from './components/ui';
import { ModalRoot } from './modals/ModalRoot';
import { Dashboard } from './views/Dashboard';
import { Projects } from './views/Projects';
import { Containers } from './views/Containers';
import { Images, Kubernetes, Networks, Volumes } from './views/Lists';
import { Cleanup } from './views/Cleanup';
import { Connections } from './views/Connections';
import { Preferences } from './views/Preferences';
import { t } from './i18n';

export function App() {
  const view = useApp((s) => s.view);
  useApp((s) => s.lang); // subscribe so App re-renders when the language changes
  const init = useApp((s) => s.init);
  const loaded = useApp((s) => s.loaded);
  const seenContainers = useRef(false);
  if (view === 'containers') seenContainers.current = true;
  const engineOn = useApp((s) => s.engine.state === 'on');

  useEffect(() => {
    if (!inTauri) return;
    void homeDir().then(setHome).catch(() => {});
    void init().catch((e) => useApp.getState().toast((e as Error).message, 'err'));
  }, [init]);

  // Ctrl K / ⌘K opens the command palette.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const st = useApp.getState();
        st.modal?.kind === 'palette' ? st.closeModal() : st.openModal({ kind: 'palette' });
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  if (!inTauri) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', color: '#C9D0DC' }}>
        {t("Dockspan needs to run inside the Tauri window. Use")} <code className="mono" style={{ margin: '0 6px' }}>pnpm tauri dev</code> {t("instead of opening it directly in a browser.")}
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexWrap: 'wrap', background: '#0E1014', color: '#E6E8EE' }}>
      <Sidebar />
      <main style={{ flex: '999 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Header />
        <EngineBanner />
        <div className={engineOn ? undefined : 'blur'} style={{ padding: '24px 28px 48px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {!loaded ? <div className="muted">{t("Connecting to Docker…")}</div> : (
            <>
              {view === 'dashboard' && <Dashboard />}
              {view === 'projects' && <Projects />}
              {/* Keep the Containers page mounted so terminal sessions are not lost when navigating to another page. */}
              {seenContainers.current && <div style={{ display: view === 'containers' ? 'flex' : 'none', flexDirection: 'column', gap: 20 }}><Containers /></div>}
              {view === 'images' && <Images />}
              {view === 'networks' && <Networks />}
              {view === 'volumes' && <Volumes />}
              {view === 'kubernetes' && <Kubernetes />}
              {view === 'cleanup' && <Cleanup />}
              {view === 'settings' && <Connections />}
              {view === 'preferences' && <Preferences />}
            </>
          )}
        </div>
      </main>
      <ModalRoot />
      <Toasts />
    </div>
  );
}
