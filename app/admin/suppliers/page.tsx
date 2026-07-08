import { Page, PageHeader } from '../../components/Page';
import { ResourceManager } from '../components/ResourceManager';

export default function SuppliersAdminPage() {
  return (
    <Page>
      <PageHeader title="Suppliers">Vendors that bills are entered against.</PageHeader>
      <ResourceManager resource="suppliers" />
    </Page>
  );
}
