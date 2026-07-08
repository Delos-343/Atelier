import { Page, PageHeader } from '../../components/Page';
import { UserManager } from '../components/UserManager';

export default function UsersAdminPage() {
  return (
    <Page>
      <PageHeader title="Users">
        Assign each person a clearance level — admin, production, quality, or viewer. Users appear
        here after they sign up; everyone defaults to viewer until given a role.
      </PageHeader>
      <UserManager />
    </Page>
  );
}
