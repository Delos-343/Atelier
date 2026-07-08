import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, q, truncateAll } from './helpers';

beforeEach(truncateAll);
afterAll(async () => {
  await pool.end();
});

type HalalStatus = 'certified' | 'not_certified' | 'in_review';

/** Insert a raw material with an explicit halal posture, returning its id. */
async function makeMaterial(
  sku: string,
  halal: { status: HalalStatus; certNo?: string | null; certifier?: string | null; expiry?: string | null },
): Promise<string> {
  const [r] = await q(
    `insert into raw_materials
       (sku, name, category, base_unit, halal_status, halal_cert_number, halal_certifier, halal_cert_expiry)
     values ($1, $1, 'aroma_chemical', 'g', $2, $3, $4, $5)
     returning id`,
    [sku, halal.status, halal.certNo ?? null, halal.certifier ?? null, halal.expiry ?? null],
  );
  return r.id;
}

/** Build a formula + one version wired to the given materials; returns the version id. */
async function makeVersion(code: string, materialIds: string[], locked = false): Promise<string> {
  const [f] = await q(`insert into formulas(code, name) values($1, $1) returning id`, [code]);
  const [fv] = await q(
    `insert into formula_versions(formula_id, version_no, basis, is_locked)
     values($1, 1, 'percent', $2) returning id`,
    [f.id, locked],
  );
  let seq = 0;
  for (const mid of materialIds) {
    seq += 1;
    await q(
      `insert into formula_components(formula_version_id, raw_material_id, quantity, unit, sequence)
       values($1, $2, 1, 'g', $3)`,
      [fv.id, mid, seq],
    );
  }
  return fv.id;
}

const reasonsFor = async (fvId: string, asOf: string) =>
  q<{ sku: string; reason: string }>(
    `select sku, reason from formula_version_halal_noncompliance($1, $2) order by sku`,
    [fvId, asOf],
  );

const verdict = async (fvId: string, asOf: string) => {
  const [{ ok }] = await q<{ ok: boolean }>(
    `select is_formula_version_halal($1, $2) as ok`,
    [fvId, asOf],
  );
  return ok;
};

describe('halal certificate CHECK constraint', () => {
  it('rejects certifying a material with no certificate number or expiry', async () => {
    await expect(makeMaterial('RM-BAD1', { status: 'certified' })).rejects.toThrow(
      /raw_materials_halal_cert_chk/,
    );
  });

  it('rejects certifying with a number but no expiry', async () => {
    await expect(
      makeMaterial('RM-BAD2', { status: 'certified', certNo: 'ONLY-NUM' }),
    ).rejects.toThrow(/raw_materials_halal_cert_chk/);
  });

  it('accepts a certified material with both number and expiry', async () => {
    const id = await makeMaterial('RM-OK', {
      status: 'certified',
      certNo: 'C-1',
      certifier: 'BPJPH',
      expiry: '2030-01-01',
    });
    expect(id).toBeTruthy();
  });

  it('allows not_certified and in_review without any certificate data', async () => {
    const a = await makeMaterial('RM-NC', { status: 'not_certified' });
    const b = await makeMaterial('RM-IR', { status: 'in_review' });
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
  });
});

describe('formula_version_halal_noncompliance reasons', () => {
  it('flags a not_certified component as "not certified"', async () => {
    const m = await makeMaterial('RM-NC', { status: 'not_certified' });
    const fv = await makeVersion('F-NC', [m]);
    const rows = await reasonsFor(fv, '2026-07-01');
    expect(rows).toEqual([{ sku: 'RM-NC', reason: 'not certified' }]);
  });

  it('flags an in_review component as "in review"', async () => {
    const m = await makeMaterial('RM-IR', { status: 'in_review' });
    const fv = await makeVersion('F-IR', [m]);
    const rows = await reasonsFor(fv, '2026-07-01');
    expect(rows).toEqual([{ sku: 'RM-IR', reason: 'in review' }]);
  });

  it('flags a certified-but-expired component as "certificate expired"', async () => {
    const m = await makeMaterial('RM-EX', {
      status: 'certified',
      certNo: 'C-EX',
      expiry: '2020-01-01',
    });
    const fv = await makeVersion('F-EX', [m]);
    const rows = await reasonsFor(fv, '2026-07-01');
    expect(rows).toEqual([{ sku: 'RM-EX', reason: 'certificate expired' }]);
  });

  it('returns every offender ordered by sku and omits the compliant one', async () => {
    const ok = await makeMaterial('RM-A-OK', {
      status: 'certified',
      certNo: 'C',
      expiry: '2030-01-01',
    });
    const nc = await makeMaterial('RM-B-NC', { status: 'not_certified' });
    const ir = await makeMaterial('RM-C-IR', { status: 'in_review' });
    const fv = await makeVersion('F-MIX', [ok, nc, ir]);
    const rows = await reasonsFor(fv, '2026-07-01');
    expect(rows.map((r) => r.sku)).toEqual(['RM-B-NC', 'RM-C-IR']);
    expect(await verdict(fv, '2026-07-01')).toBe(false);
  });
});

describe('is_formula_version_halal verdict', () => {
  it('is compliant when every component is certified and unexpired', async () => {
    const a = await makeMaterial('RM-1', { status: 'certified', certNo: 'C1', expiry: '2030-01-01' });
    const b = await makeMaterial('RM-2', { status: 'certified', certNo: 'C2', expiry: '2031-06-30' });
    const fv = await makeVersion('F-GOOD', [a, b]);
    expect(await verdict(fv, '2026-07-01')).toBe(true);
    expect(await reasonsFor(fv, '2026-07-01')).toHaveLength(0);
  });

  it('treats a version with no components as vacuously compliant', async () => {
    const fv = await makeVersion('F-EMPTY', []);
    expect(await verdict(fv, '2026-07-01')).toBe(true);
  });

  it('honors the as_of date: a cert valid on that date keeps the version compliant', async () => {
    const m = await makeMaterial('RM-EDGE', {
      status: 'certified',
      certNo: 'C-EDGE',
      expiry: '2026-06-30',
    });
    const fv = await makeVersion('F-EDGE', [m]);
    // On the expiry date itself the cert is still valid (>=).
    expect(await verdict(fv, '2026-06-30')).toBe(true);
    // The day after, it has lapsed.
    expect(await verdict(fv, '2026-07-01')).toBe(false);
  });
});

describe('formula_versions_compliance overview', () => {
  it('returns one row per version with a JSON offending payload ordered by sku', async () => {
    const ok = await makeMaterial('RM-OK', { status: 'certified', certNo: 'C', expiry: '2030-01-01' });
    const nc = await makeMaterial('RM-Z-NC', { status: 'not_certified' });
    const ir = await makeMaterial('RM-A-IR', { status: 'in_review' });

    await makeVersion('F-CLEAN', [ok], true);
    await makeVersion('F-DIRTY', [ok, nc, ir]);

    const rows = await q<{
      formula_code: string;
      is_locked: boolean;
      compliant: boolean;
      offending: { sku: string; name: string; reason: string }[];
    }>(`select formula_code, is_locked, compliant, offending from formula_versions_compliance('2026-07-01') order by formula_code`);

    expect(rows.map((r) => r.formula_code)).toEqual(['F-CLEAN', 'F-DIRTY']);

    const clean = rows.find((r) => r.formula_code === 'F-CLEAN')!;
    expect(clean.compliant).toBe(true);
    expect(clean.is_locked).toBe(true);
    expect(clean.offending).toEqual([]);

    const dirty = rows.find((r) => r.formula_code === 'F-DIRTY')!;
    expect(dirty.compliant).toBe(false);
    // ordered by sku: RM-A-IR before RM-Z-NC
    expect(dirty.offending.map((o) => o.sku)).toEqual(['RM-A-IR', 'RM-Z-NC']);
    expect(dirty.offending.map((o) => o.reason)).toEqual(['in review', 'not certified']);
  });

  it('joins the product name when the formula has one', async () => {
    const [p] = await q(`insert into products(sku, name, base_unit) values('P-X','Product X','ml') returning id`);
    const [f] = await q(
      `insert into formulas(code, name, product_id) values('F-P','F-P',$1) returning id`,
      [p.id],
    );
    await q(
      `insert into formula_versions(formula_id, version_no, basis) values($1, 1, 'percent')`,
      [f.id],
    );
    const [row] = await q<{ product_name: string }>(
      `select product_name from formula_versions_compliance('2026-07-01') where formula_code='F-P'`,
    );
    expect(row.product_name).toBe('Product X');
  });
});
