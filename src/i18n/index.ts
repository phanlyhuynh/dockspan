import { EN } from './en';
import { VI, VI_BACKEND } from './vi';

export type Lang = 'en' | 'vi';
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'vi', label: 'Tiếng Việt' },
];

const KEY = 'dockspan.lang';
const DEFAULT: Lang = 'en';

function load(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'en' || v === 'vi') return v;
  } catch {
    /* localStorage may be unavailable */
  }
  return DEFAULT;
}

let current: Lang = load();
if (typeof document !== 'undefined') document.documentElement.lang = current;

export const getLang = (): Lang => current;

export function setLang(l: Lang) {
  current = l;
  try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  if (typeof document !== 'undefined') document.documentElement.lang = l;
}

const fill = (s: string, vars?: Record<string, string | number>) =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;

/**
 * Translate a string. The key is the original **English** sentence (it may contain `{name}` placeholders for values);
 * each language has its own table (en.ts, vi.ts). A missing translation falls back to the key itself (English), never an error.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const table = current === 'vi' ? VI : EN;
  return fill(table[key] ?? key, vars);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = Object.entries(VI_BACKEND)
  .filter(([k]) => /\{\w+\}/.test(k))
  .map(([k, vi]) => {
    const names: string[] = [];
    const re = new RegExp('^' + esc(k).replace(/\\\{(\w+)\\\}/g, (_m, n) => { names.push(n); return '([\\s\\S]+?)'; }) + '$');
    return { re, names, vi };
  });

/** Translate an error message returned by the Rust backend (fixed English text). English is left as is; so is any message that matches no pattern. */
export function tBackend(msg: string): string {
  if (current === 'en') return msg;
  if (VI_BACKEND[msg]) return VI_BACKEND[msg];
  for (const p of patterns) {
    const m = p.re.exec(msg);
    if (m) return fill(p.vi, Object.fromEntries(p.names.map((n, i) => [n, m[i + 1]])));
  }
  return msg;
}

/** Locale used for date/time formatting. */
export const dateLocale = (): string => (current === 'vi' ? 'vi-VN' : 'en-US');
