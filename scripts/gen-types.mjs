/**
 * Generate `src/types/database.ts` (Supabase `Database` shape) by introspecting a
 * Postgres database — used because the official `supabase gen types` delegates to a
 * containerized postgres-meta, which isn't available in every environment.
 *
 *   DATABASE_URL=postgres://… node scripts/gen-types.mjs > src/types/database.ts
 *
 * It reads the same migrated schema your Supabase project runs, so the public-schema
 * output matches. For your live project you can equivalently run:
 *   supabase gen types typescript --linked --schema public > src/types/database.ts
 */
import { Pool } from 'pg';

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/erp_test',
});

/** Map a Postgres type (as printed by format_type / function signatures) to a TS type. */
function pgToTs(raw, enums) {
  let t = raw.trim();
  let isArray = false;
  if (t.endsWith('[]')) {
    isArray = true;
    t = t.slice(0, -2).trim();
  }
  t = t.replace(/\(.*\)/, '').trim(); // strip precision/length: numeric(12,3) -> numeric
  let base;
  switch (t) {
    case 'uuid':
    case 'text':
    case 'character varying':
    case 'varchar':
    case 'character':
    case 'char':
    case 'bpchar':
    case 'name':
    case 'citext':
      base = 'string';
      break;
    case 'smallint':
    case 'integer':
    case 'bigint':
    case 'int2':
    case 'int4':
    case 'int8':
    case 'numeric':
    case 'decimal':
    case 'real':
    case 'double precision':
    case 'float4':
    case 'float8':
      base = 'number';
      break;
    case 'boolean':
    case 'bool':
      base = 'boolean';
      break;
    case 'timestamp with time zone':
    case 'timestamp without time zone':
    case 'timestamptz':
    case 'timestamp':
    case 'date':
    case 'time':
    case 'time without time zone':
    case 'interval':
      base = 'string';
      break;
    case 'json':
    case 'jsonb':
      base = 'Json';
      break;
    default:
      base = enums.has(t) ? `Database["public"]["Enums"]["${t}"]` : 'unknown';
  }
  return isArray ? `${base}[]` : base;
}

function indent(blocks, pad) {
  return blocks
    .map((b) =>
      b
        .split('\n')
        .map((l) => (l.length ? pad + l : l))
        .join('\n'),
    )
    .join('\n');
}

/** Render a table's Relationships array (forward foreign keys) in Supabase format. */
function relationshipsBlock(rels) {
  if (!rels.length) return '  Relationships: [];';
  const entries = rels.map((r) =>
    [
      '    {',
      `      foreignKeyName: "${r.fk_name}";`,
      `      columns: [${r.columns.map((c) => `"${c}"`).join(', ')}];`,
      `      isOneToOne: ${r.is_one_to_one};`,
      `      referencedRelation: "${r.ref_table}";`,
      `      referencedColumns: [${r.ref_columns.map((c) => `"${c}"`).join(', ')}];`,
      '    }',
    ].join('\n'),
  );
  return '  Relationships: [\n' + entries.join(',\n') + '\n  ];';
}

async function main() {
  // ── Enums ────────────────────────────────────────────────────────────────
  const enumRes = await pool.query(`
    select t.typname as name,
           array_agg(e.enumlabel::text order by e.enumsortorder) as labels
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
    group by t.typname
    order by t.typname;
  `);
  const enumNames = new Set(enumRes.rows.map((r) => r.name));

  // ── Tables + columns ─────────────────────────────────────────────────────
  const colRes = await pool.query(`
    select c.relname as tbl,
           a.attname as col,
           format_type(a.atttypid, a.atttypmod) as type,
           a.attnotnull as not_null,
           (pg_get_expr(ad.adbin, ad.adrelid) is not null) as has_default
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef ad on ad.adrelid = c.oid and ad.adnum = a.attnum
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname, a.attnum;
  `);
  const tables = new Map();
  for (const r of colRes.rows) {
    if (!tables.has(r.tbl)) tables.set(r.tbl, []);
    tables.get(r.tbl).push(r);
  }

  // ── Functions ────────────────────────────────────────────────────────────
  const fnRes = await pool.query(`
    select p.proname as name,
           pg_get_function_arguments(p.oid) as args,
           pg_get_function_result(p.oid) as result
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and not exists (
        select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'
      )
    order by p.proname, p.oid;
  `);

  // ── Foreign keys → Relationships (forward FKs per owning table) ──────────
  const fkRes = await pool.query(`
    select
      con.conname as fk_name,
      cl.relname as table_name,
      fcl.relname as ref_table,
      (select array_agg(att.attname::text order by k.ord)
         from unnest(con.conkey) with ordinality k(attnum, ord)
         join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum) as columns,
      (select array_agg(fatt.attname::text order by k.ord)
         from unnest(con.confkey) with ordinality k(attnum, ord)
         join pg_attribute fatt on fatt.attrelid = con.confrelid and fatt.attnum = k.attnum) as ref_columns,
      exists (
        select 1 from pg_constraint uc
        where uc.conrelid = con.conrelid
          and uc.contype in ('u', 'p')
          and uc.conkey @> con.conkey and con.conkey @> uc.conkey
      ) as is_one_to_one
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_namespace ns on ns.oid = cl.relnamespace
    join pg_class fcl on fcl.oid = con.confrelid
    where con.contype = 'f' and ns.nspname = 'public'
    order by cl.relname, con.conname;
  `);
  const relsByTable = new Map();
  for (const r of fkRes.rows) {
    if (!relsByTable.has(r.table_name)) relsByTable.set(r.table_name, []);
    relsByTable.get(r.table_name).push(r);
  }

  // ── Render tables ────────────────────────────────────────────────────────
  const tableBlocks = [];
  for (const [tbl, cols] of [...tables].sort((a, b) => a[0].localeCompare(b[0]))) {
    const row = [];
    const ins = [];
    const upd = [];
    for (const c of cols) {
      const ts = pgToTs(c.type, enumNames);
      const nullable = !c.not_null;
      const rowT = nullable ? `${ts} | null` : ts;
      row.push(`${c.col}: ${rowT}`);
      const insOptional = c.has_default || nullable;
      ins.push(`${c.col}${insOptional ? '?' : ''}: ${rowT}`);
      upd.push(`${c.col}?: ${rowT}`);
    }
    tableBlocks.push(
      `${tbl}: {\n` +
        `  Row: {\n${indent(row, '    ')}\n  };\n` +
        `  Insert: {\n${indent(ins, '    ')}\n  };\n` +
        `  Update: {\n${indent(upd, '    ')}\n  };\n` +
        `${relationshipsBlock(relsByTable.get(tbl) ?? [])}\n` +
        `};`,
    );
  }

  // ── Render functions ─────────────────────────────────────────────────────
  const seen = new Set();
  const fnBlocks = [];
  for (const f of fnRes.rows) {
    if (seen.has(f.name)) continue; // skip overloads (rare); first signature wins
    seen.add(f.name);

    // Args
    const argLines = [];
    const argStr = (f.args || '').trim();
    if (argStr) {
      for (const partRaw of argStr.split(',')) {
        let part = partRaw.trim();
        const def = part.toUpperCase().indexOf(' DEFAULT ');
        const optional = def !== -1;
        if (optional) part = part.slice(0, def).trim();
        let words = part.split(/\s+/);
        if (['IN', 'OUT', 'INOUT', 'VARIADIC'].includes(words[0].toUpperCase())) words = words.slice(1);
        const argName = words[0];
        const argType = words.slice(1).join(' ');
        argLines.push(`${argName}${optional ? '?' : ''}: ${pgToTs(argType, enumNames)}`);
      }
    }
    const argsBlock = argLines.length
      ? `{\n${indent(argLines, '    ')}\n  }`
      : 'Record<PropertyKey, never>';

    // Returns
    const result = (f.result || '').trim();
    let returns;
    if (/^TABLE\(/i.test(result)) {
      const inner = result.slice(result.indexOf('(') + 1, result.lastIndexOf(')'));
      const fields = inner.split(',').map((seg) => {
        const w = seg.trim().split(/\s+/);
        const name = w[0];
        const type = w.slice(1).join(' ');
        return `${name}: ${pgToTs(type, enumNames)}`;
      });
      returns = `{\n${indent(fields, '    ')}\n  }[]`;
    } else if (result.toLowerCase() === 'void') {
      returns = 'undefined';
    } else if (/^SETOF\s+/i.test(result)) {
      returns = `${pgToTs(result.replace(/^SETOF\s+/i, ''), enumNames)}[]`;
    } else {
      returns = pgToTs(result, enumNames);
    }

    fnBlocks.push(`${f.name}: {\n  Args: ${argsBlock};\n  Returns: ${returns};\n};`);
  }

  // ── Render enums ─────────────────────────────────────────────────────────
  const enumBlocks = enumRes.rows.map(
    (e) => `${e.name}: ${e.labels.map((l) => `"${l}"`).join(' | ')};`,
  );

  const out = `// Generated by scripts/gen-types.mjs from the public schema. Do not edit by hand.
// Regenerate after a migration:  yarn gen:types
// (For your live project you can equivalently run:
//   supabase gen types typescript --linked --schema public > src/types/database.ts)

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
${indent(tableBlocks, '      ')}
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
${indent(fnBlocks, '      ')}
    };
    Enums: {
${indent(enumBlocks, '      ')}
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type PublicSchema = Database['public'];

export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row'];
export type TablesInsert<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Insert'];
export type TablesUpdate<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Update'];
export type Enums<T extends keyof PublicSchema['Enums']> = PublicSchema['Enums'][T];
`;

  process.stdout.write(out);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
