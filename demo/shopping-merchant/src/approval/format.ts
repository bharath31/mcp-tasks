/** Format minor units without floating-point rounding (USD: 2 fraction digits). */
export function formatUsdMinor(minor: number): string {
  const negative = minor < 0;
  const abs = negative ? -minor : minor;
  const major = Math.trunc(abs / 100);
  const frac = abs % 100;
  const body = `${major}.${String(frac).padStart(2, "0")}`;
  return negative ? `USD -${body}` : `USD ${body}`;
}
