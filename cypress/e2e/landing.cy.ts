describe('Landing', () => {
  beforeEach(() => cy.visit('/'));

  it('shows the brand and primary calls to action', () => {
    cy.contains('h1', 'TechnicoFlor').should('be.visible');
    cy.contains('a', 'Enter console').should('have.attr', 'href', '/inventory');
    cy.contains('a', 'Sign in').should('have.attr', 'href', '/login');
  });

  it('lists the four manufacturing modules in flow order', () => {
    ['Formulas', 'Production', 'Quality', 'Inventory'].forEach((m) =>
      cy.contains('.module__name', m).should('exist'),
    );
  });
});
