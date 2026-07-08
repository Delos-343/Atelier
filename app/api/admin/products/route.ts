import { makeCollectionRoute } from '@/server/crud-route';
import { productCreateSchema } from '@/schemas/master-data';

export const dynamic = 'force-dynamic';

const COLUMNS = 'id, sku, name, base_unit, created_at';

const handlers = makeCollectionRoute({
  table: 'products',
  columns: COLUMNS,
  createSchema: productCreateSchema,
});
export const GET = handlers.GET;
export const POST = handlers.POST;
