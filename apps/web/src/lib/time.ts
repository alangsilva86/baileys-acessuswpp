const dateTimeFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const relativeTimeFmt = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });

export function parseIsoToMs(iso?: string | null): number | null {
  if (!iso) return null;
  const date = new Date(iso);
  const ms = date.getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function formatDateTime(iso?: string | null): string {
  const ms = parseIsoToMs(iso);
  if (ms == null) return '';
  return dateTimeFmt.format(ms);
}

export function formatRelativeTime(iso?: string | null): string {
  const ms = parseIsoToMs(iso);
  if (ms == null) return '';
  const diffMs = ms - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const absSec = Math.abs(diffSec);
  if (absSec < 60) return relativeTimeFmt.format(diffSec, 'second');
  if (absSec < 3600) return relativeTimeFmt.format(Math.round(diffSec / 60), 'minute');
  if (absSec < 86400) return relativeTimeFmt.format(Math.round(diffSec / 3600), 'hour');
  return relativeTimeFmt.format(Math.round(diffSec / 86400), 'day');
}

