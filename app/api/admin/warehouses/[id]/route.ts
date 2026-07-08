import { makeItemRoute } from '@/server/crud-route';
import { warehouseUpdateSchema } from '@/schemas/master-data';

export const dynamic = 'force-dynamic';

const handlers = makeItemRoute({ table: 'warehouses', updateSchema: warehouseUpdateSchema });
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
