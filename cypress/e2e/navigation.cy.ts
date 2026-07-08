describe('Navigation & access', () => {
  it('redirects protected routes to sign-in when signed out', () => {
    cy.visit('/inventory', { failOnStatusCode: false });
    cy.location('pathname').should('eq', '/login');
  });

  it('shows the sign-in form', () => {
    cy.visit('/login');
    cy.get('input[type="email"]').should('exist');
    cy.get('input[type="password"]').should('exist');
    cy.contains('button', 'Sign in').should('exist');
  });
});
