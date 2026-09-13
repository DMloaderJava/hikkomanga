export function formatDate(dateString: string): string {
  try {
    const date = new Date(dateString);
    return new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(date);
  } catch {
    return dateString;
  }
}

export function formatChapterNumber(number: number): string {
  if (typeof number !== 'number' || isNaN(number)) return '0';
  return Number.isInteger(number) ? `${number}` : `${number.toFixed(1).replace(/\.0$/, '')}`;
}
