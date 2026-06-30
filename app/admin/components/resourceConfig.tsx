import type { ReactNode } from 'react';

export type FieldType = 'text' | 'number' | 'select' | 'checkbox';

export interface FieldSpec {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: { value: string; label: string }[];
  step?: string;
  placeholder?: string;
  help?: string;
}

export interface ColumnSpec {
  key: string;
  label: string;
  align?: 'right';
  render?: (value: unknown, row: Record<string, unknown>) => ReactNode;
}

export interface ResourceConfig {
  key: string;
  label: string; // singular, lowercase — used in buttons/messages
  labelPlural: string;
  basePath: string;
  titleKey: string; // which field identifies a row in the delete confirm
  columns: ColumnSpec[];
  fields: FieldSpec[];
}

const UNIT_OPTIONS = ['kg', 'g', 'mg', 'l', 'ml'].map((u) => ({ value: u, label: u }));

const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: 'aroma_chemical', label: 'Aroma chemical' },
  { value: 'essential_oil', label: 'Essential oil' },
  { value: 'fixative', label: 'Fixative' },
  { value: 'solvent', label: 'Solvent' },
  { value: 'water', label: 'Water' },
  { value: 'packaging', label: 'Packaging' },
];
const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  CATEGORY_OPTIONS.map((o) => [o.value, o.label]),
);

const dash = (v: unknown): ReactNode =>
  v === null || v === undefined || v === '' ? '—' : String(v);
const yesNo = (v: unknown): string => (v ? 'Yes' : 'No');

export const RESOURCES: Record<string, ResourceConfig> = {
  materials: {
    key: 'materials',
    label: 'material',
    labelPlural: 'Raw materials',
    basePath: '/api/admin/materials',
    titleKey: 'name',
    columns: [
      { key: 'sku', label: 'SKU' },
      { key: 'name', label: 'Name' },
      { key: 'category', label: 'Category', render: (v) => CATEGORY_LABEL[String(v)] ?? String(v) },
      { key: 'base_unit', label: 'Unit' },
      { key: 'density_g_per_ml', label: 'Density', align: 'right', render: dash },
      { key: 'standard_cost', label: 'Std cost', align: 'right', render: dash },
      { key: 'is_flammable', label: 'Flammable', render: yesNo },
    ],
    fields: [
      { name: 'sku', label: 'SKU', type: 'text', required: true, placeholder: 'RM-BERG' },
      { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Bergamot Essential Oil' },
      { name: 'category', label: 'Category', type: 'select', required: true, options: CATEGORY_OPTIONS },
      { name: 'base_unit', label: 'Base unit', type: 'select', required: true, options: UNIT_OPTIONS },
      {
        name: 'density_g_per_ml',
        label: 'Density (g/ml)',
        type: 'number',
        step: '0.0001',
        help: 'Optional — enables mass ↔ volume conversion.',
      },
      { name: 'standard_cost', label: 'Standard cost', type: 'number', step: '0.0001', placeholder: '0' },
      { name: 'is_flammable', label: 'Flammable', type: 'checkbox' },
    ],
  },

  products: {
    key: 'products',
    label: 'product',
    labelPlural: 'Products',
    basePath: '/api/admin/products',
    titleKey: 'name',
    columns: [
      { key: 'sku', label: 'SKU' },
      { key: 'name', label: 'Name' },
      { key: 'base_unit', label: 'Unit' },
    ],
    fields: [
      { name: 'sku', label: 'SKU', type: 'text', required: true, placeholder: 'FG-EDP-NO5' },
      { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Eau de Parfum No. 5' },
      { name: 'base_unit', label: 'Base unit', type: 'select', required: true, options: UNIT_OPTIONS },
    ],
  },

  warehouses: {
    key: 'warehouses',
    label: 'warehouse',
    labelPlural: 'Warehouses',
    basePath: '/api/admin/warehouses',
    titleKey: 'name',
    columns: [
      { key: 'code', label: 'Code' },
      { key: 'name', label: 'Name' },
    ],
    fields: [
      { name: 'code', label: 'Code', type: 'text', required: true, placeholder: 'WH-MAIN' },
      { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Main Warehouse' },
    ],
  },

  customers: {
    key: 'customers',
    label: 'customer',
    labelPlural: 'Customers',
    basePath: '/api/admin/customers',
    titleKey: 'name',
    columns: [
      { key: 'code', label: 'Code' },
      { key: 'name', label: 'Name' },
      { key: 'email', label: 'Email', render: dash },
      { key: 'phone', label: 'Phone', render: dash },
    ],
    fields: [
      { name: 'code', label: 'Code', type: 'text', required: true, placeholder: 'CUST-ACME' },
      { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Acme Parfums' },
      { name: 'email', label: 'Email', type: 'text', placeholder: 'buyer@acme.com' },
      { name: 'phone', label: 'Phone', type: 'text' },
      { name: 'address', label: 'Address', type: 'text' },
    ],
  },
};
