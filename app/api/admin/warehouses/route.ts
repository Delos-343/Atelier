import { makeCollectionRoute } from '@/server/crud-route';
import { warehouseCreateSchema } from '@/schemas/master-data';

export const dynamic = 'force-dynamic';

const COLUMNS = 'id, code, name, created_at';

const handlers = makeCollectionRoute({
  table: 'warehouses',
  columns: COLUMNS,
  createSchema: warehouseCreateSchema,
});
export const GET = handlers.GET;
export const POST = handlers.POST;
