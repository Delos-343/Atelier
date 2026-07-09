import nextDynamic from 'next/dynamic';
import { Page, PageHeader } from '../components/Page';

// Code-split the dashboard (charts + motion) into its own client chunk so it
// doesn't weigh on other routes' first load. SSR stays on, so there's no flash.
const Dashboard = nextDynamic(() => import('./components/Dashboard').then((m) => m.Dashboard));
import { getDashboardMetrics } from '@/server/dashboard';
import { getUserAndRole } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function AppDashboard() {

  const [metrics, { user }] = await Promise.all([getDashboardMetrics(), getUserAndRole()]);
  
  return (
    <Page>
      <PageHeader title="Operations">
        {user?.email ? `Signed in as ${user.email}. ` : ''}
        A live view of inventory, production, and quality - figures animate into view, on-load.
      </PageHeader>
      <Dashboard metrics={metrics} />
    </Page>
  );
}
