import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { useApp } from '../store';
import { t } from '../i18n';

export const ICONS = {
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  projects: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  containers: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  images: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  networks: 'M6 3v6M18 3v6M6 9h12M12 9v6M8 15h8v6H8z',
  volumes: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  cleanup: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  kubernetes: 'M12 2.5l8.5 4.1 2 9.2-5.9 7.4H7.4l-5.9-7.4 2-9.2zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 1 0 0-7M12 5v3.5M12 15.5V19M5.5 9.5l3.2 1.4M15.3 13.1l3.2 1.4M18.5 9.5l-3.2 1.4M8.7 13.1l-3.2 1.4',
  settings: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  restart: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  terminal: 'M5 7l5 5-5 5M12 18h7',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  power: 'M12 3v9M6.3 7.5a8 8 0 1 0 11.4 0',
  warn: 'M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  check: 'M5 12l5 5 9-10',
  updown: 'M8 9l4-4 4 4M8 15l4 4 4-4',
  file: 'M14 3H6v18h12V7zM14 3v4h4',
  logo: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  minus: 'M5 12h14',
  cog: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
} as const;

export function Icon({ d, size = 16, stroke = 'currentColor', sw = 2, fill = 'none' }: { d: string; size?: number; stroke?: string; sw?: number; fill?: string }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

export const FolderIcon = ({ size = 15, stroke = '#7FB0FF' }: { size?: number; stroke?: string }) => <Icon d={ICONS.projects} size={size} stroke={stroke} sw={1.8} />;
export const FileIcon = ({ size = 15 }: { size?: number }) => <Icon d={ICONS.file} size={size} stroke="#8F98A8" sw={1.8} />;

export function IconBtn({ icon, label, onClick, disabled, size = 15, className = 'ib', style }: { icon: string; label: string; onClick?: () => void; disabled?: boolean; size?: number; className?: string; style?: CSSProperties }) {
  return (
    <button className={className} aria-label={label} title={label} disabled={disabled} onClick={onClick} style={style}>
      <Icon d={icon} size={size} />
    </button>
  );
}

export function Box({ kind, children, style }: { kind: 'warn' | 'err' | 'ok' | 'info'; children: ReactNode; style?: CSSProperties }) {
  return <div className={`box ${kind}`} style={style}>{children}</div>;
}

export function Indeterminate() {
  return <div className="indet"><span /></div>;
}

export function PageHead({ title, sub, children, monoSub }: { title: string; sub?: ReactNode; children?: ReactNode; monoSub?: boolean }) {
  return (
    <div className="pagehead">
      <div>
        <h1 className="h1">{title}</h1>
        {sub != null && <p className={`sub${monoSub ? ' mono' : ''}`} style={monoSub ? { fontSize: 13 } : undefined}>{sub}</p>}
      </div>
      {children && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>{children}</div>}
    </div>
  );
}

/** Shared overlay for modals/drawers: click the backdrop or press Esc to close. */
export function Overlay({ children, right, onClose }: { children: ReactNode; right?: boolean; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className={`overlay${right ? ' right' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {children}
    </div>
  );
}

export function ModalFrame({ title, onClose, children, footer, maxWidth, large, sub }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; maxWidth?: number; large?: boolean; sub?: ReactNode }) {
  return (
    <Overlay onClose={onClose}>
      <div className={`modal${large ? ' lg' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} style={maxWidth ? { maxWidth } : undefined}>
        <div className="mh">
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <h2 className="h2">{title}</h2>
            {sub}
          </div>
          <IconBtn className="ib ghost" icon={ICONS.close} label={t("Close")} onClick={onClose} size={16} />
        </div>
        {children}
        {footer && <div className="mf">{footer}</div>}
      </div>
    </Overlay>
  );
}

export function DrawerFrame({ eyebrow, title, onClose, children, footer, maxWidth }: { eyebrow: string; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; maxWidth?: number }) {
  return (
    <Overlay right onClose={onClose}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label={eyebrow} style={maxWidth ? { maxWidth } : undefined}>
        <div className="mh">
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span className="muted" style={{ fontSize: 12 }}>{eyebrow}</span>
            <h2 className="h2 mono ell">{title}</h2>
          </div>
          <IconBtn className="ib ghost" icon={ICONS.close} label={t("Close")} onClick={onClose} size={16} />
        </div>
        {children}
        {footer && <div className="mf">{footer}</div>}
      </div>
    </Overlay>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className={`toast ${x.kind === 'ok' ? '' : x.kind}`}>
          <span className="tdot" />
          <span style={{ flex: 1, minWidth: 0 }}>{x.msg}</span>
          <IconBtn className="ib ghost" icon={ICONS.close} label={t("Close notification")} onClick={() => dismiss(x.id)} size={14} style={{ width: 28, height: 28 }} />
        </div>
      ))}
    </div>
  );
}

/** Labeled input, used in modal forms. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="lbl">{label}{children}</label>;
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="chk">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

export function KV({ k, v }: { k: string; v: ReactNode }) {
  return <div className="kv"><span className="muted">{k}</span><span>{v}</span></div>;
}
