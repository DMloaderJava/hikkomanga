/**
 * Конвертация ISO ↔ value для <input type="datetime-local">.
 * datetime-local работает в локальной TZ браузера; ISO обычно UTC —
 * прямой `.slice(0,16)` даёт сдвиг на offset (UTC+3 → −3 часа в UI).
 */

/** ISO / Date → `YYYY-MM-DDTHH:mm` в локальной TZ. */
export function toDatetimeLocalValue(isoOrDate: string | Date | null | undefined): string {
  if (!isoOrDate) return '';
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * Value из datetime-local → ISO UTC.
 * `new Date('YYYY-MM-DDTHH:mm')` парсится как local time в современных браузерах.
 */
export function fromDatetimeLocalValue(local: string | null | undefined): string | null {
  if (!local || !local.trim()) return null;
  const d = new Date(local.trim());
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
