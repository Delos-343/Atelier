import { Page, PageHeader } from '../../components/Page';
import { FormulaList } from '../components/FormulaList';

export default function FormulasAdminPage() {
  return (
    <Page>
      <PageHeader title="Formulas">
        Versioned recipes that drive production. Each version is either a percent formula (components
        sum to 100) or a mass formula (absolute amounts). Lock a version to make it immutable and
        safe to reference from production orders.
      </PageHeader>
      <FormulaList />
    </Page>
  );
}
