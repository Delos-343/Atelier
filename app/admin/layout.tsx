import type { ReactNode } from 'react';
import { requireRole } from '@/lib/auth/session';
import { AdminNav } from '../components/AdminNav';

// Server component: the clearance gate stays here. The section navigation is a
// full-height sidebar on desktop and a collapsible bar on mobile (AdminNav); each
// page keeps its own centered <Page> shell inside the content column.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireRole('admin');
  return (
    <div className="md:flex">
      <AdminNav />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
