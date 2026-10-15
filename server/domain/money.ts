// Money is always held as integer minor units (cents). Floats only appear at the
// boundary with PayPal, which expects decimal strings.

export type Cents = number;

export function toCents(value: number | string): Cents {
  const n = typeof value === "string" ? Number(value.replace(/[^0-9.-]/g, "")) : value;
  if (!Number.isFinite(n)) throw new Error(`Not a money amount: ${String(value)}`);
  return Math.round(n * 100);
}

export function toDecimal(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function format(cents: Cents, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

/**
 * Split an amount into `n` parts that sum exactly to the total. The remainder
 * cents go to the first parts, so the order of `keys` decides who pays the odd
 * cent. Callers pass keys in a stable order (participant creation order).
 */
export function splitEvenly<K>(total: Cents, keys: K[]): Map<K, Cents> {
  const out = new Map<K, Cents>();
  if (keys.length === 0) return out;
  const base = Math.trunc(total / keys.length);
  let remainder = total - base * keys.length;
  for (const k of keys) {
    let part = base;
    if (remainder > 0) {
      part += 1;
      remainder -= 1;
    } else if (remainder < 0) {
      part -= 1;
      remainder += 1;
    }
    out.set(k, part);
  }
  return out;
}

export function sum(values: Iterable<Cents>): Cents {
  let s = 0;
  for (const v of values) s += v;
  return s;
}
