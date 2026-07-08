import { Page } from '../../../components/Page';
import { FormulaEditor } from '../../components/FormulaEditor';

export default function FormulaDetailPage({ params }: { params: { id: string } }) {
  return (
    <Page>
      <FormulaEditor formulaId={params.id} />
    </Page>
  );
}
