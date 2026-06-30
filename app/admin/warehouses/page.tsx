import { Page, PageHeader } from '../../components/Page';
import { ResourceManager } from '../components/ResourceManager';

export default function WarehousesAdminPage() {
  return (
    <Page>
      <PageHeader title="Warehouses">
        Stock locations for raw materials and finished lots.
      </PageHeader>
      <ResourceManager resource="warehouses" />
    </Page>
  );
}
