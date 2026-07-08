'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

// The complete set of admin sections. (The old horizontal bar omitted Costing and
// Halal, which were reachable only from the overview cards — they belong here too.)
const ADMIN_LINKS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/formulas', label: 'Formulas' },
  { href: '/admin/materials', label: 'Materials' },
  { href: '/admin/products', label: 'Products' },
  { href: '/admin/warehouses', label: 'Warehouses' },
  { href: '/admin/costing', label: 'Costing' },
  { href: '/admin/halal', label: 'Halal' },
  { href: '/admin/customers', label: 'Customers' },
  { href: '/admin/users', label: 'Users' },
];

// Overview matches only its exact path; every other section owns its subtree.
const isActive = (pathname: string, href: string): boolean =>
  href === '/admin' ? pathname === '/admin' : pathname.startsWith(href);

/**
 * Admin section navigation. On desktop it is a vertical sidebar pinned beside the
 * content; on mobile it collapses to a compact "Admin · {section}" bar with a
 * toggle, so the links never wrap into an untidy block. Presentational only — the
 * clearance gate stays server-side in the layout.
 */
export function AdminNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const current = ADMIN_LINKS.find((l) => isActive(pathname, l.href))?.label ?? 'Overview';

  const linkClass = (href: string) =>
    `block rounded px-2.5 py-1.5 text-[0.9rem] transition-colors ${
      isActive(pathname, href)
        ? 'bg-surface font-medium text-text'
        : 'text-text-soft hover:bg-surface hover:text-text'
    }`;

  return (
    <aside className="md:w-56 md:flex-shrink-0 md:border-r md:border-border md:bg-surface-2">
      {/* Mobile: compact current-section bar with a toggle */}
      <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-2 px-5 py-2.5 md:hidden">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="section-label">Admin</span>
          <span className="truncate text-[0.85rem] text-muted">· {current}</span>
        </span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-expanded={open}
          aria-controls="admin-sections"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Close' : 'Sections'}
        </button>
      </div>

      {/* Sections: collapsible on mobile, a sticky column on desktop */}
      <nav
        id="admin-sections"
        aria-label="Admin sections"
        className={`${
          open ? 'block' : 'hidden'
        } border-b border-border bg-surface-2 px-3 py-3 md:sticky md:top-14 md:block md:max-h-[calc(100vh-3.5rem)] md:overflow-y-auto md:border-0 md:py-5`}
      >
        <span className="section-label mb-2 hidden px-2.5 md:block">Admin</span>
        <ul className="flex flex-col gap-0.5">
          {ADMIN_LINKS.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                onClick={() => setOpen(false)}
                aria-current={isActive(pathname, l.href) ? 'page' : undefined}
                className={linkClass(l.href)}
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-3 border-t border-border pt-3">
          <Link
            href="/app"
            onClick={() => setOpen(false)}
            className="block rounded px-2.5 py-1.5 text-[0.85rem] text-muted hover:bg-surface hover:text-text"
          >
            ← Back to app
          </Link>
        </div>
      </nav>
    </aside>
  );
}
