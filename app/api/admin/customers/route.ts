import { makeCollectionRoute } from '@/server/crud-route';
import { customerCreateSchema } from '@/schemas/sales';

export const dynamic = 'force-dynamic';

const handlers = makeCollectionRoute({
  table: 'customers',
  columns: 'id, code, name, email, phone, address, created_at',
  createSchema: customerCreateSchema,
});
export const GET = handlers.GET;
export const POST = handlers.POST;
