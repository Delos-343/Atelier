import Link from 'next/link';
import { Page, PageHeader } from '../components/Page';

const SECTIONS = [
  { href: '/admin/formulas', title: 'Formulas', desc: 'Versioned recipes with percent or mass components and locking.' },
  { href: '/admin/materials', title: 'Raw materials', desc: 'Aroma chemicals, oils, solvents, and packaging.' },
  { href: '/admin/products', title: 'Products', desc: 'Finished goods produced from formulas.' },
  { href: '/admin/warehouses', title: 'Warehouses', desc: 'Stock locations for materials and finished lots.' },
  { href: '/admin/suppliers', title: 'Suppliers', desc: 'Vendors you buy from, with payment terms for their bills.' },
  { href: '/admin/costing', title: 'Costing rates', desc: 'Standard labor and overhead rates applied to finished-goods cost.' },
  { href: '/admin/tax', title: 'Tax settings', desc: 'The house VAT/PPN rate applied to taxable customers\u2019 invoices.' },
  { href: '/admin/halal', title: 'Halal compliance', desc: 'Record material halal certificates and see which formulas are compliant.' },
  { href: '/admin/users', title: 'Users', desc: 'Assign clearance levels to the people who sign in.' },
];

export default function AdminOverview() {
  return (
    <Page>
      <PageHeader title="Administration">
        Manage the application&rsquo;s master data. These sections require admin clearance; every
        change is validated server-side and enforced again by row-level security.
      </PageHeader>
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))]">
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href} className="card no-underline transition-colors hover:border-border-strong">
            <h2 className="mb-1.5 text-[1.05rem] font-semibold text-text">{s.title}</h2>
            <p className="text-[0.9rem] text-muted">{s.desc}</p>
            <span className="mt-3 inline-block text-[0.82rem] text-accent">Manage →</span>
          </Link>
        ))}
      </div>
    </Page>
  );
}
