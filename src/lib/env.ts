const SENSITIVE_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|PRIVATE|CREDENTIAL)/i;
const URL_CREDENTIALS = /(:\/\/[^:/\s@]+:)([^@\s]+)(@)/;

export const MASK = '••••••';

/** Hide sensitive `.env` values: *_SECRET/_TOKEN/_PASSWORD… keys and passwords in URLs. */
export function maskEnv(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/.exec(line);
      if (!m) return line;
      const [, pre, key, eq, val] = m;
      if (SENSITIVE_KEY.test(key) && val.trim() !== '') return `${pre}${key}${eq}${MASK}`;
      return `${pre}${key}${eq}${val.replace(URL_CREDENTIALS, `$1${MASK}$3`)}`;
    })
    .join('\n');
}
