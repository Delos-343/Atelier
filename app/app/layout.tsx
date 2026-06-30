import type { ReactNode } from 'react';
import { requireAuth } from '@/lib/auth/session';
import { OfflineProvider } from '../components/offline/OfflineProvider';

export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireAuth();
  return <OfflineProvider>{children}</OfflineProvider>;
}
