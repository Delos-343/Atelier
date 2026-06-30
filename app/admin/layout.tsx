import type { ReactNode } from 'react';
import Link from 'next/link';
import { requireRole } from '@/lib/auth/session';

const ADMIN_LINKS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/formulas', label: 'Formulas' },
  { href: '/admin/materials', label: 'Materials' },
  { href: '/admin/products', label: 'Products' },
  { href: '/admin/warehouses', label: 'Warehouses' },
  { href: '/admin/customers', label: 'Customers' },
  { href: '/admin/users', label: 'Users' },
];

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireRole('admin');
  return (
    <div>
      <div className="border-b border-border bg-surface-2">
        <div className="mx-auto flex max-w-content flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 text-[0.82rem]">
          <span className="section-label">Admin</span>
          {ADMIN_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="nav-link">
              {l.label}
            </Link>
          ))}
          <Link href="/app" className="nav-link ml-auto">
            ← Back to app
          </Link>
        </div>
      </div>
      {children}
    </div>
  );
}
