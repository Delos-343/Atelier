import { OfflineBanner } from '../../app/components/offline/OfflineBanner';

describe('<OfflineBanner>', () => {
  it('renders nothing when online with no pending changes', () => {
    cy.mount(<OfflineBanner online={true} pendingCount={0} onSync={() => {}} />);
    cy.get('.offbar').should('not.exist');
  });

  it('announces the offline state', () => {
    cy.mount(<OfflineBanner online={false} pendingCount={0} onSync={() => {}} />);
    cy.contains('Offline').should('be.visible');
  });

  it('offers a sync action when changes are queued online', () => {
    const onSync = cy.stub().as('sync');
    cy.mount(<OfflineBanner online={true} pendingCount={2} onSync={onSync} />);
    cy.contains('2 changes waiting to sync').should('be.visible');
    cy.contains('button', 'Sync now').click();
    cy.get('@sync').should('have.been.calledOnce');
  });
});
