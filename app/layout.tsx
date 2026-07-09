import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { SiteNav } from './components/SiteNav';
import { ServiceWorkerRegister } from './components/ServiceWorkerRegister';
import { SessionProvider, type SessionUser } from './components/auth/SessionProvider';
import { ThemeProvider } from './components/theme/ThemeProvider';
import { getUserAndRole } from '@/lib/auth/session';
import './globals.css';

export const metadata: Metadata = {
  title: 'TechnicoFlor — Perfume ERP',
  description: 'Manufacturing core: formula, production, quality control, inventory.',
  manifest: '/manifest.webmanifest',
  applicationName: 'TechnicoFlor',
  appleWebApp: { capable: true, title: 'TechnicoFlor', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f3efe6' },
    { media: '(prefers-color-scheme: dark)', color: '#07182b' },
  ],
  width: 'device-width',
  initialScale: 1,
};

// Sets the theme before first paint to prevent a flash of the wrong mode.
const themeScript = `(function(){try{var p=localStorage.getItem('atelier-theme')||'system';var d=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';}catch(e){document.documentElement.dataset.theme='light';}})();`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { user, role } = await getUserAndRole();
  // Per-request CSP nonce set by middleware; stamps our inline theme script so
  // it satisfies the strict Content-Security-Policy (Next handles its own scripts).
  const nonce = headers().get('x-nonce') ?? undefined;
  const initialUser: SessionUser | null = user ? { id: user.id, email: user.email ?? null } : null;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ThemeProvider>
          <SessionProvider initialUser={initialUser} initialRole={role}>
            <SiteNav />
            {children}
            <ServiceWorkerRegister />
          </SessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
