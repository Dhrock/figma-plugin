import type { XdAffineTransform } from './clip-path';
import type { XdLayerBounds } from './types';

export interface XdPolygonPoint {
  x?: number;
  y?: number;
}

export interface XdShapeGeometry extends XdLayerBounds {
  offsetX: number;
  offsetY: number;
}

export interface XdLineGeometry extends XdShapeGeometry {
  /** Line endpoints rebased to the local bounds origin for Figma VectorNode. */
  pathData: string;
}

export type AffineTransform2D = [
  [number, number, number],
  [number, number, number],
];

/**
 * Recover XD polygon geometry from AGC's point array.
 *
 * AGC stores `shape.points` as an array, while `uxdesign#cornerCount` stores
 * the number of corners. Treating `shape.points` as a number collapses every
 * polygon to the 0.01 px safety size used by the package schema.
 */
export function xdPolygonGeometry(
  points: readonly XdPolygonPoint[] | undefined,
  explicitWidth?: number,
  explicitHeight?: number,
): XdShapeGeometry {
  const validPoints = (points ?? [])
    .map((point) => ({ x: finite(point.x), y: finite(point.y) }))
    .filter((point): point is { x: number; y: number } => point.x !== null && point.y !== null);

  if (!validPoints.length) {
    return {
      x: 0,
      y: 0,
      offsetX: 0,
      offsetY: 0,
      width: positiveFinite(explicitWidth) ?? 0,
      height: positiveFinite(explicitHeight) ?? 0,
    };
  }

  const minimumX = Math.min(...validPoints.map((point) => point.x));
  const minimumY = Math.min(...validPoints.map((point) => point.y));
  const maximumX = Math.max(...validPoints.map((point) => point.x));
  const maximumY = Math.max(...validPoints.map((point) => point.y));
  return {
    x: minimumX,
    y: minimumY,
    offsetX: minimumX,
    offsetY: minimumY,
    width: positiveFinite(maximumX - minimumX) ?? positiveFinite(explicitWidth) ?? 0,
    height: positiveFinite(maximumY - minimumY) ?? positiveFinite(explicitHeight) ?? 0,
  };
}

export function xdPolygonPointCount(
  cornerCount: unknown,
  points: readonly XdPolygonPoint[] | undefined,
): number | undefined {
  const explicit = finite(cornerCount);
  if (explicit !== null && explicit >= 3) return Math.round(explicit);
  return points && points.length >= 3 ? points.length : undefined;
}

/**
 * Preserve both endpoints of an XD line instead of reducing it to width/height.
 *
 * A Figma LineNode always draws along its local X axis, so resizing it with a
 * large height does not produce a vertical line. A normalized vector path keeps
 * vertical, diagonal and reversed lines intact before the node transform is
 * applied.
 */
export function xdLineGeometry(
  inputX1: unknown,
  inputY1: unknown,
  inputX2: unknown,
  inputY2: unknown,
): XdLineGeometry {
  const x1 = finite(inputX1) ?? 0;
  const y1 = finite(inputY1) ?? 0;
  const x2 = finite(inputX2) ?? 0;
  const y2 = finite(inputY2) ?? 0;
  const minimumX = Math.min(x1, x2);
  const minimumY = Math.min(y1, y2);
  const startX = x1 - minimumX;
  const startY = y1 - minimumY;
  const endX = x2 - minimumX;
  const endY = y2 - minimumY;
  return {
    x: minimumX,
    y: minimumY,
    offsetX: minimumX,
    offsetY: minimumY,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
    pathData: `M ${pathNumber(startX)} ${pathNumber(startY)} L ${pathNumber(endX)} ${pathNumber(endY)}`,
  };
}

/** Apply XD/SVG's [a c tx; b d ty] matrix to a local point. */
export function xdTransformPoint(
  transform: XdAffineTransform | undefined,
  point: { x: number; y: number },
): { x: number; y: number } {
  const a = finite(transform?.a) ?? 1;
  const b = finite(transform?.b) ?? 0;
  const c = finite(transform?.c) ?? 0;
  const d = finite(transform?.d) ?? 1;
  const tx = finite(transform?.tx) ?? 0;
  const ty = finite(transform?.ty) ?? 0;
  return {
    x: a * point.x + c * point.y + tx,
    y: b * point.x + d * point.y + ty,
  };
}

export function xdRotationDegrees(transform: XdAffineTransform | undefined): number {
  const a = finite(transform?.a) ?? 1;
  const b = finite(transform?.b) ?? 0;
  return Math.atan2(b, a) * 180 / Math.PI;
}

/**
 * Convert XD's clockwise-positive angle to Figma's rotation property.
 *
 * XD's 2D matrix is [cos -sin; sin cos], while Figma documents rotation as
 * [cos sin; -sin cos]. Negating the angle makes both matrices render the same
 * orientation. Canonicalize half turns to +180 so validation is stable.
 */
export function figmaRotationFromXdDegrees(xdClockwiseDegrees: number): number {
  const safeAngle = Number.isFinite(xdClockwiseDegrees) ? xdClockwiseDegrees : 0;
  const normalized = ((-safeAngle + 180) % 360 + 360) % 360 - 180;
  if (Math.abs(Math.abs(normalized) - 180) <= 0.000001) return 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}

/**
 * Transform a local-space offset into parent space without applying the
 * matrix's translation column.
 */
export function transformLocalOffset(
  transform: AffineTransform2D,
  offset: { x: number; y: number },
): { x: number; y: number } {
  const [[a, c], [b, d]] = transform;
  return {
    x: a * offset.x + c * offset.y,
    y: b * offset.x + d * offset.y,
  };
}

/**
 * Measure a resized Figma node after its relative transform (rotation first,
 * translation last), including the portion of a visible stroke outside the
 * geometric bounds.
 */
export function transformedVisualBounds(
  width: number,
  height: number,
  transform: AffineTransform2D,
  strokeOutset = 0,
): XdLayerBounds {
  const [[a, c, tx], [b, d, ty]] = transform;
  const points = [
    transformedPoint(0, 0, a, b, c, d, tx, ty),
    transformedPoint(width, 0, a, b, c, d, tx, ty),
    transformedPoint(0, height, a, b, c, d, tx, ty),
    transformedPoint(width, height, a, b, c, d, tx, ty),
  ];
  const safeOutset = Math.max(0, Number.isFinite(strokeOutset) ? strokeOutset : 0);
  const minimumX = Math.min(...points.map((point) => point.x)) - safeOutset;
  const minimumY = Math.min(...points.map((point) => point.y)) - safeOutset;
  const maximumX = Math.max(...points.map((point) => point.x)) + safeOutset;
  const maximumY = Math.max(...points.map((point) => point.y)) + safeOutset;
  return {
    x: minimumX,
    y: minimumY,
    width: maximumX - minimumX,
    height: maximumY - minimumY,
  };
}

function transformedPoint(
  x: number,
  y: number,
  a: number,
  b: number,
  c: number,
  d: number,
  tx: number,
  ty: number,
): { x: number; y: number } {
  return { x: a * x + c * y + tx, y: b * x + d * y + ty };
}

function finite(value: unknown): number | null {
  const converted = Number(value);
  return value !== null && value !== undefined && Number.isFinite(converted) ? converted : null;
}

function positiveFinite(value: unknown): number | null {
  const converted = finite(value);
  return converted !== null && converted > 0 ? converted : null;
}

function pathNumber(value: number): string {
  return Object.is(value, -0) ? '0' : String(value);
}
