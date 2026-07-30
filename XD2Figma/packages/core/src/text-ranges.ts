import type { XdTextRange } from './types';

export interface ResolvedXdTextRange {
  start: number;
  end: number;
  range: XdTextRange;
  sourceIndex: number;
  extendedToTextEnd: boolean;
}

/**
 * Resolve XD's contiguous style ranges into explicit [start, end) spans.
 *
 * XD keeps applying the last style range to every character after that
 * range's declared length. Figma does not: unstyled trailing characters keep
 * Figma's defaults. Making the continuation explicit prevents silent 12 px
 * fallback text and clipped area-text after import.
 */
export function resolveXdTextStyleRanges(
  characters: string,
  ranges: readonly XdTextRange[],
): ResolvedXdTextRange[] {
  if (!characters.length || !ranges.length) return [];

  const resolved: ResolvedXdTextRange[] = [];
  let cursor = 0;
  for (let sourceIndex = 0; sourceIndex < ranges.length && cursor < characters.length; sourceIndex += 1) {
    const range = ranges[sourceIndex];
    const length = Number.isFinite(range.length) ? Math.max(0, Math.trunc(range.length)) : 0;
    const end = Math.min(characters.length, cursor + length);
    if (end > cursor) {
      resolved.push({ start: cursor, end, range, sourceIndex, extendedToTextEnd: false });
      cursor = end;
    }
  }

  if (cursor < characters.length) {
    const sourceIndex = ranges.length - 1;
    const range = ranges[sourceIndex];
    const previous = resolved[resolved.length - 1];
    if (previous?.sourceIndex === sourceIndex) {
      previous.end = characters.length;
      previous.extendedToTextEnd = true;
    } else {
      resolved.push({ start: cursor, end: characters.length, range, sourceIndex, extendedToTextEnd: true });
    }
  }
  return resolved;
}
