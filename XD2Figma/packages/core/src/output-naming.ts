export function formatDateStamp(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('');
}

export function sanitizeOutputStem(documentName: string): string {
  const withoutExtension = String(documentName ?? '').trim().replace(/\.xd$/i, '');
  const sanitized = withoutExtension
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 80);
  return sanitized || 'untitled';
}

export function buildOutputFolderName(dateStamp: string, documentName: string, testNumber: number): string {
  if (!/^\d{8}$/.test(dateStamp)) throw new Error(`Invalid date stamp: ${dateStamp}`);
  if (!Number.isInteger(testNumber) || testNumber < 1 || testNumber > 9999) throw new Error(`Invalid test number: ${testNumber}`);
  return `${dateStamp}_${sanitizeOutputStem(documentName)}_test${String(testNumber).padStart(2, '0')}`;
}

export function nextOutputTestNumber(entryNames: string[], dateStamp: string, documentName: string): number {
  const prefix = `${dateStamp}_${sanitizeOutputStem(documentName)}_test`;
  let maximum = 0;
  for (const name of entryNames) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    maximum = Math.max(maximum, Number(suffix));
  }
  return maximum + 1;
}
