export interface PointTextSizingPlan {
  textAutoResize: 'WIDTH_AND_HEIGHT';
  width: number | null;
}

/** Point text must hug its rendered glyphs before its XD anchor is positioned. */
export function pointTextSizingPlan(_explicitWidth: number | undefined): PointTextSizingPlan {
  return { textAutoResize: 'WIDTH_AND_HEIGHT', width: null };
}

/**
 * Older direct-converter packages stored XD's point-text alignment anchor in x.
 * New packages explicitly mark x as TOP_LEFT and must not be adjusted again.
 */
export function pointTextPositionX(
  sourceX: number,
  renderedWidth: number,
  textAlign: 'LEFT' | 'CENTER' | 'RIGHT',
  positioningMode: 'TOP_LEFT' | undefined,
  isLegacyDirectPackage: boolean,
  anchorOffsetX?: number,
): number {
  if (positioningMode === 'TOP_LEFT' && typeof anchorOffsetX === 'number' && Number.isFinite(anchorOffsetX)) {
    const anchorX = sourceX - anchorOffsetX;
    if (textAlign === 'RIGHT') return anchorX - renderedWidth;
    if (textAlign === 'CENTER') return anchorX - renderedWidth / 2;
    return anchorX;
  }
  if (positioningMode === 'TOP_LEFT' || !isLegacyDirectPackage || textAlign === 'LEFT') return sourceX;
  if (textAlign === 'RIGHT') return sourceX - renderedWidth;
  return sourceX - renderedWidth / 2;
}

/**
 * New direct-converter packages store `sourceY` at an XD-estimated top edge,
 * while `anchorOffsetY` retains the offset from XD's baseline anchor to that
 * edge. Rebuild the baseline anchor first, then subtract Figma's measured
 * first-line baseline. XD line height cannot be used as Figma's baseline
 * distance because the latter also depends on the resolved font metrics.
 */
export function pointTextPositionY(
  sourceY: number,
  figmaBaselineFromTop: number | undefined,
  positioningMode: 'TOP_LEFT' | undefined,
  anchorOffsetY?: number,
): number {
  if (
    positioningMode !== 'TOP_LEFT'
    || typeof anchorOffsetY !== 'number'
    || !Number.isFinite(anchorOffsetY)
    || typeof figmaBaselineFromTop !== 'number'
    || !Number.isFinite(figmaBaselineFromTop)
    || figmaBaselineFromTop <= 0
  ) return sourceY;
  const xdBaselineY = sourceY - anchorOffsetY;
  return xdBaselineY - figmaBaselineFromTop;
}
