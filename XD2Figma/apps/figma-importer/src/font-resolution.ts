import type { XdDocument } from '../../../packages/core/src';

export interface ImportFontName {
  family: string;
  style: string;
}

export type FontResolutionReason = 'exact' | 'noto-sans' | 'last-resort';

export interface FontResolutionCandidate {
  fontName: ImportFontName;
  reason: FontResolutionReason;
}

export interface RequestedFont extends ImportFontName {
  nodeGuids: string[];
}

export function importFontKey(family: string, style: string): string {
  return `${family.trim().toLocaleLowerCase()}\u0000${style.trim().toLocaleLowerCase()}`;
}

export function collectRequestedFonts(document: Pick<XdDocument, 'fonts' | 'nodes'>): RequestedFont[] {
  const requested = new Map<string, RequestedFont>();
  const add = (family: string, style: string, nodeGuids: string[]): void => {
    const key = importFontKey(family, style);
    const existing = requested.get(key);
    if (existing) {
      existing.nodeGuids = [...new Set([...existing.nodeGuids, ...nodeGuids])];
      return;
    }
    requested.set(key, { family, style, nodeGuids: [...new Set(nodeGuids)] });
  };

  for (const font of document.fonts) add(font.family, font.style, font.nodeGuids);
  for (const node of document.nodes) {
    for (const range of node.text?.styleRanges ?? []) add(range.fontFamily, range.fontStyle, [node.guid]);
  }
  return [...requested.values()];
}

/**
 * Return candidates in import order. An exact source face wins; otherwise the
 * closest Noto Sans face is used. Inter/other installed fonts are retained only
 * as a last-resort so a missing Noto installation does not discard the text.
 */
export function createFontResolutionCandidates(
  requested: ImportFontName,
  available: ImportFontName[],
): FontResolutionCandidate[] {
  const unique = deduplicateFonts(available);
  const result: FontResolutionCandidate[] = [];
  const added = new Set<string>();
  const append = (fonts: ImportFontName[], reason: FontResolutionReason): void => {
    for (const font of fonts) {
      const key = importFontKey(font.family, font.style);
      if (added.has(key)) continue;
      added.add(key);
      result.push({ fontName: font, reason });
    }
  };

  append(unique.filter((font) => importFontKey(font.family, font.style) === importFontKey(requested.family, requested.style)), 'exact');

  const preferJapaneseNoto = isJapaneseSourceFamily(requested.family);
  const noto = unique
    .filter((font) => isNotoSansFamily(font.family))
    .sort((left, right) => notoFamilyRank(left.family, preferJapaneseNoto) - notoFamilyRank(right.family, preferJapaneseNoto)
      || styleDistance(left.style, requested.style) - styleDistance(right.style, requested.style)
      || left.style.localeCompare(right.style));
  append(noto, 'noto-sans');

  const inter = unique
    .filter((font) => normalize(font.family) === 'inter')
    .sort((left, right) => styleDistance(left.style, requested.style) - styleDistance(right.style, requested.style));
  append(inter, 'last-resort');

  const remaining = unique
    .filter((font) => !added.has(importFontKey(font.family, font.style)))
    .sort((left, right) => styleDistance(left.style, requested.style) - styleDistance(right.style, requested.style)
      || left.family.localeCompare(right.family));
  append(remaining, 'last-resort');
  return result;
}

function deduplicateFonts(fonts: ImportFontName[]): ImportFontName[] {
  const seen = new Set<string>();
  return fonts.filter((font) => {
    const key = importFontKey(font.family, font.style);
    if (!font.family.trim() || !font.style.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isNotoSansFamily(family: string): boolean {
  return normalize(family).startsWith('noto sans');
}

function isJapaneseSourceFamily(family: string): boolean {
  const normalized = normalize(family).replace(/[\s_-]+/g, '');
  return /(japanese|cjk.*jp|jp$|yugothic|yumincho|hiragino|kozuka|meiryo|morisawa|ryumin|gothicmb|sourcehansansjp|sourcehanserifjp)/.test(normalized)
    || /[ぁ-んァ-ヶ一-龠々〆〤]/.test(family);
}

function notoFamilyRank(family: string, preferJapanese: boolean): number {
  const normalized = normalize(family);
  if (preferJapanese) {
    if (normalized === 'noto sans jp') return 0;
    if (normalized === 'noto sans cjk jp') return 1;
    if (normalized === 'noto sans') return 2;
    return 3;
  }
  if (normalized === 'noto sans') return 0;
  if (normalized === 'noto sans jp') return 1;
  if (normalized === 'noto sans cjk jp') return 2;
  return 3;
}

function styleDistance(candidate: string, requested: string): number {
  const candidateStyle = parseStyle(candidate);
  const requestedStyle = parseStyle(requested);
  const italicPenalty = candidateStyle.italic === requestedStyle.italic ? 0 : 1_000;
  const normalizedPenalty = normalize(candidate) === normalize(requested) ? -10_000 : 0;
  return normalizedPenalty + italicPenalty + Math.abs(candidateStyle.weight - requestedStyle.weight);
}

function parseStyle(style: string): { weight: number; italic: boolean } {
  const normalized = normalize(style).replace(/[\s_-]+/g, '');
  let weight = 400;
  if (/(thin|hairline)/.test(normalized)) weight = 100;
  else if (/(extralight|ultralight)/.test(normalized)) weight = 200;
  else if (/light/.test(normalized)) weight = 300;
  else if (/(medium|book)/.test(normalized)) weight = 500;
  else if (/(semibold|demibold)/.test(normalized)) weight = 600;
  else if (/(extrabold|ultrabold)/.test(normalized)) weight = 800;
  else if (/(black|heavy)/.test(normalized)) weight = 900;
  else if (/bold/.test(normalized)) weight = 700;
  return { weight, italic: /(italic|oblique)/.test(normalized) };
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}
