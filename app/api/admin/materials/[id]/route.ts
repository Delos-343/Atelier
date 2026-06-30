import { makeItemRoute } from '@/server/crud-route';
import { materialUpdateSchema } from '@/schemas/master-data';

export const dynamic = 'force-dynamic';

const handlers = makeItemRoute({ table: 'raw_materials', updateSchema: materialUpdateSchema });
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
