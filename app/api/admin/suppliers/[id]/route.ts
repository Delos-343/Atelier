import { makeItemRoute } from '@/server/crud-route';
import { supplierUpdateSchema } from '@/schemas/purchasing';

export const dynamic = 'force-dynamic';

const handlers = makeItemRoute({ table: 'suppliers', updateSchema: supplierUpdateSchema });
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
