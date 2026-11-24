import { useLayoutEffect, useRef, type ReactNode } from 'react';

type IconName = 'brand' | 'plus' | 'list' | 'git' | 'browser' | 'chevron' | 'network' | 'terminal'
  | 'bookmark' | 'search' | 'edit' | 'link' | 'close' | 'check' | 'front' | 'back' | 'settings';

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <svg className={className} aria-hidden="true"><use href={`#i-${name}`} /></svg>;
}

export function Dialog({ id, title, description, children, onClose, initialFocus }: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
  onClose: () => void;
  initialFocus?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    if (initialFocus) dialog.querySelector<HTMLElement>(initialFocus)?.focus();
    return () => { dialog.close(); };
  }, [initialFocus]);

  return <dialog id={id} ref={ref} aria-labelledby={`${id}-title`} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className="dialog-header">
      <div><h2 id={`${id}-title`}>{title}</h2><p>{description}</p></div>
      <button className="icon-button" type="button" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
    </header>
    {children}
  </dialog>;
}

export function Badge({ children, color }: { children: ReactNode; color?: 'ok' | 'pending' | 'error' }) {
  return <span className={`badge${color ? ` ${color}` : ''}`}><i />{children}</span>;
}

const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export function formatTime(value: string) { return clock.format(new Date(value)); }
