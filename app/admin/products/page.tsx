import { Page, PageHeader } from '../../components/Page';
import { ResourceManager } from '../components/ResourceManager';

export default function ProductsAdminPage() {
  return (
    <Page>
      <PageHeader title="Products">Finished goods produced from formulas.</PageHeader>
      <ResourceManager resource="products" />
    </Page>
  );
}
