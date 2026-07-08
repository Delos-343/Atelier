import { describe, it, expect } from 'vitest';
import { mapRpcError } from '../pg-error';

describe('mapRpcError — status-code contract', () => {
  const base = { fallback: 'Fallback.' };

  it('maps 42501 to 403, preferring the caller-supplied forbidden message', () => {
    expect(mapRpcError({ code: '42501', message: 'admin clearance required' }, base)).toEqual({
      error: 'Admin clearance required.',
      status: 403,
    });
    expect(mapRpcError({ code: '42501' }, { ...base, forbidden: 'No access.' })).toEqual({
      error: 'No access.',
      status: 403,
    });
  });

  it('maps P0002 to 404: caller notFound wins, else the error message passes through', () => {
    expect(mapRpcError({ code: 'P0002', message: 'no such formula' }, base)).toEqual({
      error: 'no such formula',
      status: 404,
    });
    expect(
      mapRpcError({ code: 'P0002', message: 'ignored' }, { ...base, notFound: 'No such user.' }),
    ).toEqual({ error: 'No such user.', status: 404 });
  });

  it('maps P0001 to 409, passing the raised message through', () => {
    expect(mapRpcError({ code: 'P0001', message: 'cannot delete the last admin' }, base)).toEqual({
      error: 'cannot delete the last admin',
      status: 409,
    });
  });

  it('falls back to notAllowed for a message-less P0001 (defensive)', () => {
    expect(mapRpcError({ code: 'P0001' }, { ...base, notAllowed: 'Not allowed.' })).toEqual({
      error: 'Not allowed.',
      status: 409,
    });
  });

  it('maps unknown codes (and null) to 500 with message then fallback', () => {
    expect(mapRpcError({ code: '12345', message: 'boom' }, base)).toEqual({
      error: 'boom',
      status: 500,
    });
    expect(mapRpcError(null, base)).toEqual({ error: 'Fallback.', status: 500 });
  });
});
