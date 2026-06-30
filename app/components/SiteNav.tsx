'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from './theme/ThemeToggle';
import { useSession } from './auth/SessionProvider';

const MODULE_LINKS = [
  { href: '/app', label: 'Dashboard' },
  { href: '/app/formulas', label: 'Formulas' },
  { href: '/app/production', label: 'Production' },
  { href: '/app/qc', label: 'Quality' },
  { href: '/app/inventory', label: 'Inventory' },
  { href: '/app/sales', label: 'Sales' },
];

export function SiteNav() {
  const [open, setOpen] = useState(false); // mobile menu
  const [userMenu, setUserMenu] = useState(false); // desktop account dropdown
  const pathname = usePathname();
  const { user, role, isConfigured, signOut, loading } = useSession();

  const showModules = !isConfigured || !!user;
  const showSignIn = isConfigured && !user;

  const links = [...MODULE_LINKS];
  if (role === 'admin') links.push({ href: '/admin', label: 'Admin' });

  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!userMenu) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setUserMenu(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [userMenu]);

  const initial = (user?.email ?? '?').charAt(0).toUpperCase();

  return (
    <nav className="nav-bar" aria-label="Primary">
      <div className="mx-auto flex max-w-content items-center justify-between gap-4 px-5 py-[0.85rem]">
        <Link href="/" className="inline-flex flex-col no-underline" onClick={() => setOpen(false)}>
          <span className="whitespace-nowrap text-[1.05rem] font-semibold uppercase tracking-[0.18em] text-text">
            Atelier
          </span>
          <span className="mt-[3px] h-0.5 w-[26px] bg-gradient-to-r from-accent to-transparent" aria-hidden="true" />
        </Link>

        <ul
          className={`${
            open ? 'flex' : 'hidden'
          } absolute inset-x-0 top-full z-20 flex-col items-stretch gap-0 border-b border-border bg-bg p-4 shadow-lg md:static md:z-auto md:flex md:flex-row md:items-center md:gap-1.5 md:border-0 md:bg-transparent md:p-0 md:shadow-none`}
        >
          {showModules &&
            links.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className="nav-link block border-b border-border py-3 text-[0.95rem] md:border-0 md:py-1.5 md:text-[0.88rem]"
                  aria-current={(l.href === '/app' ? pathname === '/app' : pathname.startsWith(l.href)) ? 'page' : undefined}
                  onClick={() => setOpen(false)}
                >
                  {l.label}
                </Link>
              </li>
            ))}

          {user && (
            <li className="mt-2 flex items-center justify-between gap-3 border-t border-border pt-3 md:hidden">
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[0.85rem] text-text-soft">{user.email}</span>
                {role && <span className="text-[0.72rem] uppercase tracking-[0.06em] text-muted">{role}</span>}
              </span>
              <button className="btn btn-sm btn-ghost" onClick={() => void signOut()} disabled={loading}>
                Sign out
              </button>
            </li>
          )}
          {showSignIn && (
            <li className="mt-2 border-t border-border pt-3 md:hidden">
              <Link href="/login" className="btn btn-sm w-full" onClick={() => setOpen(false)}>
                Sign in
              </Link>
            </li>
          )}
        </ul>

        <div className="flex items-center gap-1.5">
          <ThemeToggle />

          {showSignIn && (
            <Link href="/login" className="btn btn-sm hidden md:inline-flex">
              Sign in
            </Link>
          )}

          {user && (
            <div className="relative hidden md:block" ref={menuRef}>
              <button
                type="button"
                className="icon-btn"
                aria-haspopup="menu"
                aria-expanded={userMenu}
                aria-label="Account menu"
                onClick={() => setUserMenu((v) => !v)}
              >
                <span className="text-[0.82rem] font-semibold">{initial}</span>
              </button>
              {userMenu && (
                <div
                  role="menu"
                  className="absolute right-0 top-[calc(100%+0.4rem)] z-30 w-56 rounded border border-border bg-surface p-2 shadow-lg"
                >
                  <div className="border-b border-border px-2 pb-2">
                    <p className="truncate text-[0.85rem] text-text">{user.email}</p>
                    {role && (
                      <span className="mt-1 inline-block text-[0.72rem] uppercase tracking-[0.06em] text-muted">
                        {role} clearance
                      </span>
                    )}
                  </div>
                  <button
                    role="menuitem"
                    className="mt-1 w-full rounded px-2 py-1.5 text-left text-[0.88rem] text-text hover:bg-surface-2"
                    onClick={() => {
                      setUserMenu(false);
                      void signOut();
                    }}
                    disabled={loading}
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            className="icon-btn md:hidden"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              {open ? (
                <path strokeLinecap="round" d="M6 6l12 12M18 6 6 18" />
              ) : (
                <path strokeLinecap="round" d="M4 7h16M4 12h16M4 17h16" />
              )}
            </svg>
          </button>
        </div>
      </div>
    </nav>
  );
}
