import { Page, PageHeader } from '../../components/Page';
import { ResourceManager } from '../components/ResourceManager';

export default function MaterialsAdminPage() {
  return (
    <Page>
      <PageHeader title="Raw materials">
        Aroma chemicals, oils, solvents, and packaging used in formulas.
      </PageHeader>
      <ResourceManager resource="materials" />
    </Page>
  );
}
