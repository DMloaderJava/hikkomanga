import { useEffect, useId, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useNavigate } from '@tanstack/react-router';
import type { Title } from '@/data/types';

interface SearchBarProps {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  suggestions?: Title[];
}

export function SearchBar({
  value,
  onChange,
  placeholder = 'Поиск по названию или автору...',
  suggestions = [],
}: SearchBarProps) {
  const navigate = useNavigate();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const showSuggestions = open && value.trim().length > 0 && suggestions.length > 0;
  const visible = suggestions.slice(0, 7);

  useEffect(() => {
    setActiveIndex(-1);
  }, [value, suggestions]);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  const goTo = (title: Title) => {
    setOpen(false);
    navigate({ to: '/title/$slug', params: { slug: title.slug } });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions) {
      if (e.key === 'Escape' && value) {
        onChange('');
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % visible.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? visible.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0 && visible[activeIndex]) {
        e.preventDefault();
        goTo(visible[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div className="relative w-full" ref={rootRef}>
      <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500 pointer-events-none" />
      <Input
        type="text"
        role="combobox"
        aria-expanded={showSuggestions}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined
        }
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        className="pl-10 pr-10 bg-[#1c1418] border-rose-950/40 text-sm focus-visible:ring-rose-500 h-11 rounded-xl shadow-sm transition-all duration-200"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange('');
            setOpen(false);
          }}
          className="absolute right-3.5 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white transition-colors duration-200"
          aria-label="Очистить поиск"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      {showSuggestions && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-30 mt-2 max-h-72 w-full overflow-y-auto rounded-xl border border-rose-950/40 bg-[#1c1418] shadow-xl shadow-black/40"
        >
          {visible.map((t, i) => (
            <li key={t.id} role="none">
              <button
                type="button"
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => goTo(t)}
                className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors duration-150 ${
                  i === activeIndex ? 'bg-rose-950/45 text-white' : 'text-neutral-200 hover:bg-rose-950/30'
                }`}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[#2a1c22]">
                  {t.cover_url ? (
                    <img src={t.cover_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-[10px] font-bold text-rose-200">{t.title.slice(0, 2)}</span>
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-white">{t.title}</span>
                  {t.author && (
                    <span className="block truncate text-xs text-neutral-400">{t.author}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
