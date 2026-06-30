import { Page, PageHeader } from '../components/Page';
import { Dashboard } from './components/Dashboard';
import { getDashboardMetrics } from '@/server/dashboard';
import { getUserAndRole } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function AppDashboard() {
  const [metrics, { user }] = await Promise.all([getDashboardMetrics(), getUserAndRole()]);
  return (
    <Page>
      <PageHeader title="Operations">
        {user?.email ? `Signed in as ${user.email}. ` : ''}A live view of inventory, production, and
        quality — figures animate in on load.
      </PageHeader>
      <Dashboard metrics={metrics} />
    </Page>
  );
}
