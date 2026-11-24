import { useCallback, useEffect, useRef, useState } from 'react';
import { explain } from './api.ts';
import { Icon } from './ui.tsx';

type Page<T> = { items: T[]; nextPage: number | null };
type LoadPage<T> = (query: string, page: number, signal: AbortSignal) => Promise<Page<T>>;

export function SearchPicker<T>({ title, searchLabel, scope, load, itemKey, label, selected, onChange }: {
  title: string;
  searchLabel: string;
  scope: string;
  load: LoadPage<T>;
  itemKey: (item: T) => string;
  label: (item: T) => string;
  selected: ReadonlySet<string>;
  onChange: (item: T, checked: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const page = usePagedOptions(open ? scope : '', query.trim(), load);
  const unique = [...new Map(page.items.map((item) => [itemKey(item), item])).values()];
  const { nextPage, loading, error, more } = page;

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || loading || error || !nextPage || !results.current || !end.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) more();
    }, { root: results.current, rootMargin: '0px 0px 40px 0px' });
    observer.observe(end.current);
    return () => observer.disconnect();
  }, [open, loading, error, nextPage, more]);

  useEffect(() => {
    results.current?.scrollTo(0, 0);
  }, [query, scope]);

  return <details className="search-picker" onToggle={(event) => {
    setOpen(event.currentTarget.open);
    if (!event.currentTarget.open) { setQuery(''); page.clear(); }
  }}>
    <summary>{title}</summary>
    {open && <div className="picker-panel">
      <label className="search-field picker-search"><Icon name="search" />
        <input ref={input} type="search" aria-label={searchLabel} placeholder={searchLabel} autoComplete="off"
          onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
          value={query} onChange={(event) => {
            const next = event.target.value;
            if (next.trim() !== query.trim()) page.clear();
            setQuery(next);
          }} />
      </label>
      <div className="picker-results" ref={results} role="group" aria-label={title} aria-busy={loading} tabIndex={0}>
        {unique.map((item) => <label className="picker-option" key={itemKey(item)}>
          <input type="checkbox" checked={selected.has(itemKey(item))} onChange={(event) => onChange(item, event.target.checked)} />
          <span>{label(item)}</span>
        </label>)}
        {loading && <p className="picker-message" role="status">正在加载…</p>}
        {error && <div className="picker-message"><p role="alert">{error}</p>
          <button type="button" className="text-button" onClick={page.retry}>重试</button></div>}
        {!loading && !error && !unique.length && <p className="picker-message" role="status">{query.trim() ? '没有找到匹配项。' : '暂无可选项。'}</p>}
        <div className="picker-end" ref={end} aria-hidden="true" />
      </div>
      {nextPage && !loading && !error && <p className="picker-hint">向下滚动查看更多</p>}
    </div>}
  </details>;
}

function usePagedOptions<T>(scope: string, query: string, load: LoadPage<T>) {
  const key = `${scope}\0${query}`;
  const [requested, setRequested] = useState({ key, page: 1, attempt: 0 });
  const [result, setResult] = useState<{ key: string; page: number; attempt: number; items: T[]; nextPage: number | null; error?: string }>();
  const { page, attempt } = requested.key === key ? requested : { page: 1, attempt: 0 };
  const current = result?.key === key ? result : undefined;
  const loading = Boolean(scope) && (current?.page !== page || current?.attempt !== attempt);
  const nextPage = current?.nextPage ?? null;

  useEffect(() => {
    if (!scope) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void load(query, page, controller.signal).then((response) => {
        if (controller.signal.aborted) return;
        setResult((previous) => ({
          key, page, attempt, nextPage: response.nextPage,
          items: page > 1 && previous?.key === key ? [...previous.items, ...response.items] : response.items,
        }));
      }).catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setResult((previous) => ({
          key, page, attempt, nextPage: null, error: explain(failure),
          items: previous?.key === key ? previous.items : [],
        }));
      });
    }, query && page === 1 ? 240 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [scope, key, query, page, attempt, load]);

  return {
    items: current?.items ?? [], nextPage, loading, error: loading ? undefined : current?.error,
    more: useCallback(() => { if (nextPage && !loading) setRequested({ key, page: nextPage, attempt: 0 }); }, [key, loading, nextPage]),
    retry: () => setRequested({ key, page, attempt: attempt + 1 }),
    clear: () => { setRequested({ key: '', page: 1, attempt: 0 }); setResult(undefined); },
  };
}
