import type { XdLayerBounds } from './types';

export interface XdAffineTransform {
  a?: number;
  b?: number;
  c?: number;
  d?: number;
  tx?: number;
  ty?: number;
}

/**
 * Resolve an XD clip shape into the local coordinate space shared by the
 * clipped group's children. The returned origin must be added to the group
 * position and subtracted from each direct child position.
 */
export function xdClipPathBounds(
  geometry: XdLayerBounds,
  transform: XdAffineTransform = {},
): XdLayerBounds {
  const a = finite(transform.a, 1);
  const b = finite(transform.b, 0);
  const c = finite(transform.c, 0);
  const d = finite(transform.d, 1);
  const tx = finite(transform.tx, 0);
  const ty = finite(transform.ty, 0);
  const x0 = geometry.x;
  const y0 = geometry.y;
  const x1 = geometry.x + geometry.width;
  const y1 = geometry.y + geometry.height;
  const points = [
    point(x0, y0, a, b, c, d, tx, ty),
    point(x1, y0, a, b, c, d, tx, ty),
    point(x0, y1, a, b, c, d, tx, ty),
    point(x1, y1, a, b, c, d, tx, ty),
  ];
  const minX = Math.min(...points.map((value) => value.x));
  const minY = Math.min(...points.map((value) => value.y));
  const maxX = Math.max(...points.map((value) => value.x));
  const maxY = Math.max(...points.map((value) => value.y));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function point(
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

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
