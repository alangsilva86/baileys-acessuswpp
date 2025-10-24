import type Long from 'long';

export function toIsoDate(timestamp?: number | Long | bigint | null): string {
  if (timestamp == null) return new Date().toISOString();

  let millis: number | null = null;

  if (typeof timestamp === 'number') {
    if (Number.isFinite(timestamp)) {
      millis = timestamp > 1e12 ? timestamp : timestamp * 1000;
    }
  } else if (typeof timestamp === 'bigint') {
    const asNumber = Number(timestamp);
    if (Number.isFinite(asNumber)) {
      millis = asNumber > 1e12 ? asNumber : asNumber * 1000;
    }
  } else if (typeof timestamp === 'object' && timestamp !== null) {
    const longValue = timestamp as Long;
    if (typeof longValue.toNumber === 'function') {
      const candidate = longValue.toNumber();
      if (Number.isFinite(candidate)) {
        millis = candidate > 1e12 ? candidate : candidate * 1000;
      }
    }
  }

  if (millis == null) return new Date().toISOString();
  return new Date(millis).toISOString();
}
