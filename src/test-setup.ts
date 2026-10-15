// Tests run in the app's default language (English); the i18n tests switch languages explicitly.
import { setLang } from './i18n';

const store: Record<string, string> = {};
(globalThis as unknown as { localStorage: Storage }).localStorage ??= {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  key: () => null,
  length: 0,
} as Storage;
setLang('en');
