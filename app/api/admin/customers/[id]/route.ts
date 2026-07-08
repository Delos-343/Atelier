import { makeItemRoute } from '@/server/crud-route';
import { customerUpdateSchema } from '@/schemas/sales';

export const dynamic = 'force-dynamic';

const handlers = makeItemRoute({ table: 'customers', updateSchema: customerUpdateSchema });
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
