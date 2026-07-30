export interface XdTextFallbackGeometry {
  width: number;
  height: number;
  lineCount: number;
  maxLineLength: number;
}

export interface XdPointTextAlignmentGeometry {
  /** Offset from XD's alignment anchor to the visual left edge. */
  offsetX: number;
  /** Exact XD line width when it can be recovered from the alignment anchor. */
  width?: number;
}

export interface XdPointTextBaselineGeometry {
  /** Offset from XD's first-line baseline anchor to the visual top edge. */
  offsetY: number;
  /** First-line height used to recover the baseline after Figma auto-sizing. */
  firstLineHeight: number;
}

/**
 * XD AGC uses a baseline anchor only for `positioned` point text.
 * `area` and `autoHeight` frames store transform.tx/ty at the frame's
 * top-left, so applying point-text baseline correction to them moves the
 * whole text frame upward by one line.
 */
export function xdTextFrameLayoutBox(frameType: unknown): 'POINT' | 'AREA' | 'AUTO_HEIGHT' {
  if (frameType === 'area') return 'AREA';
  if (frameType === 'autoHeight') return 'AUTO_HEIGHT';
  return 'POINT';
}

/**
 * Figma displays LF reliably, while XD source text may contain standalone CR.
 * Replacing one UTF-16 code unit with one code unit keeps XD style-range offsets
 * valid. The caller must retain the original source string for audit/recovery.
 */
export function normalizeCharactersForFigma(characters: string): string {
  return characters.replace(/\r/g, '\n');
}

/**
 * Estimate point-text bounds only when XD did not store an explicit frame size.
 * CR and LF are intentionally treated as independent line breaks so the result
 * has the same line structure as normalizeCharactersForFigma().
 */
export function estimateXdTextFallbackGeometry(
  characters: string,
  fontSize: number,
  lineHeight: number,
  explicitWidth?: number,
  explicitHeight?: number,
): XdTextFallbackGeometry {
  const safeFontSize = positiveFinite(fontSize) ?? 12;
  const safeLineHeight = positiveFinite(lineHeight) ?? safeFontSize * 1.2;
  const lines = characters.split(/[\r\n]/);
  const maxLineLength = Math.max(0, ...lines.map((line) => line.length));
  const lineCount = Math.max(1, lines.length);
  return {
    width: positiveFinite(explicitWidth) ?? Math.max(1, maxLineLength * safeFontSize * 0.58),
    height: positiveFinite(explicitHeight) ?? Math.max(1, lineCount * safeLineHeight),
    lineCount,
    maxLineLength,
  };
}

/**
 * Recover point-text left edge and width from XD AGC line starts.
 *
 * For positioned point text, XD stores tx at the alignment anchor. Right- and
 * center-aligned lines therefore start at a negative local x. Figma expects the
 * TextNode's x to be the frame's left edge, so passing tx through unchanged
 * shifts the text to the right.
 */
export function xdPointTextAlignmentGeometry(
  textAlign: 'LEFT' | 'CENTER' | 'RIGHT',
  lineStartXs: Array<number | null | undefined>,
): XdPointTextAlignmentGeometry {
  const starts = lineStartXs.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const minimum = starts.length ? Math.min(...starts) : 0;
  if (minimum >= 0 || textAlign === 'LEFT') return { offsetX: 0 };
  if (textAlign === 'RIGHT') return { offsetX: minimum, width: -minimum };
  return { offsetX: minimum, width: -minimum * 2 };
}

/**
 * XD AGC stores positioned point-text ty at the first-line baseline. Figma
 * stores TextNode.y at the frame's top edge. The explicit XD line height is the
 * most stable cross-font baseline distance available to the direct adapter.
 */
export function xdPointTextBaselineGeometry(
  fontSize: number,
  lineHeight?: number,
): XdPointTextBaselineGeometry {
  const safeFontSize = positiveFinite(fontSize) ?? 12;
  const firstLineHeight = positiveFinite(lineHeight) ?? safeFontSize * 1.2;
  return { offsetY: -firstLineHeight, firstLineHeight };
}

function positiveFinite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
