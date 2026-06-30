/**
 * Locale-aware number formatting shared across screens.
 *
 * `money` renders a fixed-decimal amount (default 2 places) using the runtime
 * locale's grouping/separators — the formatter the production and sales detail
 * screens were each defining locally. The dashboard's stat/chart figures use a
 * distinct rounded, zero-decimal style (see `charts.tsx`) and intentionally
 * stay there.
 */
export function money(value: number, opts?: { decimals?: number }): string {
  const decimals = opts?.decimals ?? 2;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Same as `money`, but renders an em dash for a null/undefined amount. */
export const moneyOrDash = (
  value: number | null | undefined,
  opts?: { decimals?: number },
): string => (value == null ? '—' : money(value, opts));
