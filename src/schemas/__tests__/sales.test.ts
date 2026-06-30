import { describe, it, expect } from 'vitest';
import { customerCreateSchema, createSalesOrderSchema } from '../sales';

const UUID = '11111111-1111-1111-1111-111111111111';
const UUID2 = '22222222-2222-2222-2222-222222222222';

describe('sales schemas', () => {
  describe('customerCreateSchema', () => {
    it('accepts a minimal payload (code + name)', () => {
      expect(customerCreateSchema.safeParse({ code: 'C1', name: 'Acme' }).success).toBe(true);
    });

    it('treats an empty email/phone/address as omitted', () => {
      const r = customerCreateSchema.safeParse({ code: 'C1', name: 'Acme', email: '', phone: '', address: '' });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.email).toBeUndefined();
        expect(r.data.phone).toBeUndefined();
      }
    });

    it('validates a non-empty email', () => {
      expect(customerCreateSchema.safeParse({ code: 'C1', name: 'Acme', email: 'nope' }).success).toBe(false);
      expect(customerCreateSchema.safeParse({ code: 'C1', name: 'Acme', email: 'a@b.com' }).success).toBe(true);
    });

    it('requires code and name', () => {
      expect(customerCreateSchema.safeParse({ name: 'Acme' }).success).toBe(false);
      expect(customerCreateSchema.safeParse({ code: 'C1' }).success).toBe(false);
    });
  });

  describe('createSalesOrderSchema', () => {
    const valid = {
      code: 'SO-1',
      customerId: UUID,
      warehouseId: UUID2,
      lines: [{ productId: UUID, quantity: 3, unit: 'l', unitPrice: 2.0 }],
    };

    it('accepts a well-formed order', () => {
      expect(createSalesOrderSchema.safeParse(valid).success).toBe(true);
    });

    it('defaults unitPrice to 0 when omitted', () => {
      const r = createSalesOrderSchema.safeParse({
        ...valid,
        lines: [{ productId: UUID, quantity: 1, unit: 'l' }],
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.lines[0].unitPrice).toBe(0);
    });

    it('rejects an order with no lines', () => {
      expect(createSalesOrderSchema.safeParse({ ...valid, lines: [] }).success).toBe(false);
    });

    it('rejects a non-uuid customer', () => {
      expect(createSalesOrderSchema.safeParse({ ...valid, customerId: 'x' }).success).toBe(false);
    });

    it('rejects a non-positive quantity', () => {
      const r = createSalesOrderSchema.safeParse({
        ...valid,
        lines: [{ productId: UUID, quantity: 0, unit: 'l', unitPrice: 1 }],
      });
      expect(r.success).toBe(false);
    });
  });
});
