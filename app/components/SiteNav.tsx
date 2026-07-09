'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { ThemeToggle } from './theme/ThemeToggle';
import { useSession } from './auth/SessionProvider';

/**
 * Navigation model. Links stay on ONE line inside a horizontal scroller: the
 * strip slides, the edges fade, and small chevron controls appear only when
 * there's more to reach. Links are grouped only visually (a hairline divider
 * between categories); admin-only entries are filtered out for non-admins and an
 * empty group is dropped, so the bar is naturally shorter for lower clearances.
 * The bar fades/settles in on load and the links stagger; reduced-motion off.
 */
type Item = { href: string; label: string; admin?: boolean; exact?: boolean };

const GROUPS: Item[][] = [
  [{ href: '/app', label: 'Dashboard', exact: true }],
  [
    { href: '/app/formulas', label: 'Formulas' },
    { href: '/app/production', label: 'Production' },
    { href: '/app/qc', label: 'Quality' },
    { href: '/app/inventory', label: 'Inventory' },
  ],
  [
    { href: '/app/sales', label: 'Sales' },
    { href: '/app/receivables', label: 'Receivables', admin: true },
    { href: '/app/receipts', label: 'Receipts', admin: true },
    { href: '/app/documents', label: 'Documents', admin: true },
  ],
  [
    { href: '/app/procurement', label: 'Procurement', admin: true },
    { href: '/app/payables', label: 'Payables', admin: true },
  ],
  [
    { href: '/app/tax-report', label: 'Tax Report', admin: true },
    { href: '/app/email-history', label: 'Email History', admin: true },
  ],
  [{ href: '/admin', label: 'Admin', admin: true }],
];

const FADE_EDGE = 32; // px of edge fade when there's more to scroll

export function SiteNav() {
  const [userMenu, setUserMenu] = useState(false);
  const pathname = usePathname();
  const { user, role, isConfigured, signOut, loading } = useSession();
  const reduced = useReducedMotion();

  const isAdmin = role === 'admin';
  const showModules = !isConfigured || !!user;
  const showSignIn = isConfigured && !user;

  const groups = useMemo(
    () => GROUPS.map((g) => g.filter((i) => !i.admin || isAdmin)).filter((g) => g.length > 0),
    [isAdmin],
  );

  const linkActive = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  // ── Horizontal scroller: edge fade + chevron affordances ──────────────────
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const updateEdges = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    updateEdges();
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateEdges);
      return () => window.removeEventListener('resize', updateEdges);
    }
    const ro = new ResizeObserver(updateEdges);
    ro.observe(el);
    window.addEventListener('resize', updateEdges);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateEdges);
    };
  }, [updateEdges, groups.length]);

  const nudge = (dir: 1 | -1) =>
    scrollerRef.current?.scrollBy({ left: dir * 240, behavior: 'smooth' });

  const maskImage = `linear-gradient(to right, transparent 0, #000 ${
    edges.left ? FADE_EDGE : 0
  }px, #000 calc(100% - ${edges.right ? FADE_EDGE : 0}px), transparent 100%)`;

  useEffect(() => {
    setUserMenu(false);
    const el = scrollerRef.current?.querySelector('[aria-current="page"]') as HTMLElement | null;
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [pathname]);

  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!userMenu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setUserMenu(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setUserMenu(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [userMenu]);

  const initial = (user?.email ?? '?').charAt(0).toUpperCase();

  // Load animation config (disabled under reduced motion).
  const barMotion = reduced
    ? {}
    : {
        initial: { opacity: 0, y: -12 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as const },
      };
  const linkMotion = (i: number) =>
    reduced
      ? {}
      : {
          initial: { opacity: 0, y: -6 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.32, delay: 0.12 + i * 0.035, ease: 'easeOut' as const },
        };

  // Print/document routes render as bare sheets — no app chrome.
  if (pathname.startsWith('/print')) return null;

  let linkIndex = -1; // running index across groups for the entrance stagger

  return (
    <motion.nav className="nav-bar" aria-label="Primary" {...barMotion}>
      <div className="mx-auto flex max-w-content items-center gap-4 px-5 py-3 sm:gap-6">
        <Link href="/" aria-label="TechnicoFlor home" className="flex shrink-0 items-center gap-2.5 no-underline">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/mark.png" alt="" width={26} height={30} className="h-[26px] w-auto" />
          <span className="hidden whitespace-nowrap text-[1.05rem] font-semibold tracking-[0.01em] text-text sm:inline">
            TechnicoFlor
          </span>
        </Link>

        {showModules && (
          <div className="relative min-w-0 flex-1">
            <button
              type="button"
              aria-label="Scroll navigation left"
              tabIndex={edges.left ? 0 : -1}
              onClick={() => nudge(-1)}
              className={`nav-arrow left-0 ${edges.left ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
            >
              <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12.5 5 7.5 10l5 5" />
              </svg>
            </button>

            <div
              ref={scrollerRef}
              onScroll={updateEdges}
              className="nav-scroller flex items-center gap-1 overflow-x-auto px-1"
              style={{ maskImage, WebkitMaskImage: maskImage }}
            >
              {groups.map((group, gi) => (
                <div key={gi} className="flex shrink-0 items-center gap-1">
                  {gi > 0 && <span aria-hidden className="mx-2 h-4 w-px shrink-0 bg-border" />}
                  {group.map((l) => {
                    linkIndex += 1;
                    return (
                      <motion.div key={l.href} className="shrink-0" {...linkMotion(linkIndex)}>
                        <Link
                          href={l.href}
                          className="nav-link block whitespace-nowrap px-[0.7rem] py-1.5 text-[0.88rem]"
                          aria-current={linkActive(l.href, l.exact) ? 'page' : undefined}
                        >
                          {l.label}
                        </Link>
                      </motion.div>
                    );
                  })}
                </div>
              ))}
            </div>

            <button
              type="button"
              aria-label="Scroll navigation right"
              tabIndex={edges.right ? 0 : -1}
              onClick={() => nudge(1)}
              className={`nav-arrow right-0 ${edges.right ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
            >
              <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 5l5 5-5 5" />
              </svg>
            </button>
          </div>
        )}

        <div className="flex shrink-0 items-center gap-2">
          <ThemeToggle />

          {showSignIn && (
            <Link href="/login" className="btn btn-sm">
              Sign in
            </Link>
          )}

          {user && (
            <div className="relative" ref={menuRef}>
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
                  className="absolute right-0 top-[calc(100%+0.5rem)] z-30 w-56 rounded border border-border bg-surface p-2 shadow-lg"
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
        </div>
      </div>
    </motion.nav>
  );
}
