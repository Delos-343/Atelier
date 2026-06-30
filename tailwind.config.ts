import type { Config } from 'tailwindcss';

/**
 * Dark mode keys off our existing ThemeProvider, which sets `data-theme` on <html>.
 * Semantic colors resolve to CSS custom properties, so the light/dark swap and the
 * sea-blue gradient are driven by the same tokens as before — utilities just read them.
 */
const config: Config = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        text: 'var(--text)',
        'text-soft': 'var(--text-soft)',
        muted: 'var(--muted)',
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        accent: 'var(--accent)',
        'accent-2': 'var(--accent-2)',
        'accent-ink': 'var(--accent-ink)',
        ok: 'var(--ok)',
        warn: 'var(--warn)',
        bad: 'var(--bad)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      maxWidth: {
        content: '1080px',
      },
    },
  },
  plugins: [],
};

export default config;
