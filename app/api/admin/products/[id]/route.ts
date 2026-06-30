import { makeItemRoute } from '@/server/crud-route';
import { productUpdateSchema } from '@/schemas/master-data';

export const dynamic = 'force-dynamic';

const handlers = makeItemRoute({ table: 'products', updateSchema: productUpdateSchema });
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
