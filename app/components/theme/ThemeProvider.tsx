'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

type Theme = 'light' | 'dark';
type Pref = Theme | 'system';

const STORAGE_KEY = 'atelier-theme';

interface ThemeContextValue {
  theme: Theme; // resolved (what's actually shown)
  pref: Pref; // user preference
  setPref: (p: Pref) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>');
  return ctx;
}

function systemTheme(): Theme {
  return typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function resolve(p: Pref): Theme {
  return p === 'system' ? systemTheme() : p;
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<Pref>('system');
  const [theme, setTheme] = useState<Theme>('light');

  // hydrate from storage (the inline head script already set the attribute to avoid a flash)
  useEffect(() => {
    const stored = (localStorage.getItem(STORAGE_KEY) as Pref | null) ?? 'system';
    setPrefState(stored);
    const resolved = resolve(stored);
    setTheme(resolved);
    apply(resolved);
  }, []);

  // follow the OS when preference is "system"
  useEffect(() => {
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const resolved = systemTheme();
      setTheme(resolved);
      apply(resolved);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  const setPref = useCallback((p: Pref) => {
    setPrefState(p);
    localStorage.setItem(STORAGE_KEY, p);
    const resolved = resolve(p);
    setTheme(resolved);
    apply(resolved);
  }, []);

  const toggle = useCallback(() => {
    setPref(resolve(pref) === 'dark' ? 'light' : 'dark');
  }, [pref, setPref]);

  return (
    <ThemeContext.Provider value={{ theme, pref, setPref, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}
