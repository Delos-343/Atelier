import { Page, PageHeader } from '../../components/Page';
import { ResourceManager } from '../components/ResourceManager';

export default function CustomersAdminPage() {
  return (
    <Page>
      <PageHeader title="Customers">Buyers that sales orders are placed for.</PageHeader>
      <ResourceManager resource="customers" />
    </Page>
  );
}
