import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';

// Separate terminal window, opened with ?term=<container id>.
const q = new URLSearchParams(window.location.search);
const termId = q.get('term');

async function boot() {
  // Fake backend for building the UI in a browser (`/?mock`); excluded from the production build.
  if (import.meta.env.DEV && q.has('mock')) await import('./dev/mock');
  const { App } = await import('./App');
  const { TerminalWindow } = await import('./views/ContainerTabs');
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {termId ? <TerminalWindow id={termId} name={q.get('name') ?? termId.slice(0, 12)} /> : <App />}
    </React.StrictMode>,
  );
}
void boot();
