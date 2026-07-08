describe('Theme', () => {
  it('toggles between light and dark', () => {
    cy.visit('/');
    cy.get('html')
      .invoke('attr', 'data-theme')
      .then((initial) => {
        cy.get('button[aria-label*="mode"]').first().click();
        cy.get('html').should(($h) => {
          expect($h.attr('data-theme')).to.not.equal(initial);
        });
      });
  });

  it('persists the choice across a reload', () => {
    cy.visit('/');
    cy.get('button[aria-label*="mode"]').first().click();
    cy.get('html')
      .invoke('attr', 'data-theme')
      .then((chosen) => {
        cy.reload();
        cy.get('html').should('have.attr', 'data-theme', String(chosen));
      });
  });
});
