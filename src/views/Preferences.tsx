import { LANGS, t } from '../i18n';
import { useApp } from '../store';
import { PageHead } from '../components/ui';

/** Settings page (header gear button): currently holds the interface language. */
export function Preferences() {
  const lang = useApp((s) => s.lang);
  const setLang = useApp((s) => s.setLang);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
      <PageHead title={t("Settings")} sub={t("Application preferences")} />
      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="secth">
          <h2 className="h2">{t("Language")}</h2>
          <span className="muted" style={{ fontSize: 13 }}>{t("Applies immediately, no restart needed")}</span>
        </div>
        <div className="card" style={{ padding: 18, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }} role="radiogroup" aria-label={t("Language")}>
          {LANGS.map((l) => (
            <button key={l.id} role="radio" aria-checked={lang === l.id} className={lang === l.id ? 'btn on' : 'btn'} onClick={() => setLang(l.id)}>{l.label}</button>
          ))}
        </div>
      </section>
    </div>
  );
}
