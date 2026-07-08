import { makeCollectionRoute } from '@/server/crud-route';
import { supplierCreateSchema } from '@/schemas/purchasing';

export const dynamic = 'force-dynamic';

const handlers = makeCollectionRoute({
  table: 'suppliers',
  columns: 'id, code, name, email, phone, address, tax_id, payment_terms_days, created_at',
  createSchema: supplierCreateSchema,
});
export const GET = handlers.GET;
export const POST = handlers.POST;
