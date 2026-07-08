import { makeCollectionRoute } from '@/server/crud-route';
import { materialCreateSchema } from '@/schemas/master-data';

export const dynamic = 'force-dynamic';

const COLUMNS =
  'id, sku, name, category, base_unit, density_g_per_ml, standard_cost, is_flammable, created_at';

const handlers = makeCollectionRoute({
  table: 'raw_materials',
  columns: COLUMNS,
  createSchema: materialCreateSchema,
});
export const GET = handlers.GET;
export const POST = handlers.POST;
