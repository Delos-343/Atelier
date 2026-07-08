import { makeCollectionRoute } from '@/server/crud-route';
import { customerCreateSchema } from '@/schemas/sales';

export const dynamic = 'force-dynamic';

const handlers = makeCollectionRoute({
  table: 'customers',
  columns: 'id, code, name, email, phone, address, tax_id, payment_terms_days, tax_exempt, discount_pct, created_at',
  createSchema: customerCreateSchema,
});
export const GET = handlers.GET;
export const POST = handlers.POST;
