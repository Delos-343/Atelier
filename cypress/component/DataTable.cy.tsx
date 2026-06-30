import { DataTable, type Column } from '../../app/components/DataTable';

interface Row { id: string; name: string; qty: number }
const columns: Column<Row>[] = [
  { key: 'name', header: 'Name' },
  { key: 'qty', header: 'Quantity', align: 'right', render: (r) => <span className="mono">{r.qty}</span> },
];

describe('<DataTable>', () => {
  it('renders headers and a labelled cell for each row', () => {
    const rows: Row[] = [
      { id: '1', name: 'Bergamot', qty: 12 },
      { id: '2', name: 'Iso E Super', qty: 4 },
    ];
    cy.mount(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    cy.contains('th', 'Quantity').should('exist');
    cy.get('tbody tr').should('have.length', 2);
    cy.contains('td', 'Bergamot').should('have.attr', 'data-label', 'Name');
  });
});
