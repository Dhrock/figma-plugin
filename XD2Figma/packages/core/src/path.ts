type Point = { x: number; y: number };
type Cubic = { control1: Point; control2: Point; to: Point };

export interface PathNormalizationOptions {
  maxDeviationPx?: number;
  transformScale?: number;
}

export interface PathNormalizationResult {
  sourcePathData: string;
  normalizedPathData: string;
  windingRule: 'EVENODD' | 'NONZERO';
  maxDeviationPx: number;
  generatedCubicSegments: number;
}

export interface SvgPathBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PathOriginNormalizationResult extends PathNormalizationResult {
  /** Path data translated so its geometric bounds begin at (0, 0). */
  originPathData: string;
  /** Geometric bounds in the source path coordinate system. */
  bounds: SvgPathBounds;
}

const ARGUMENTS: Record<string, number> = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0,
};

/** Convert full SVG path syntax to Figma's absolute M/L/Q/C/Z subset. */
export function normalizeSvgPath(
  sourcePathData: string,
  windingRule: 'EVENODD' | 'NONZERO' = 'NONZERO',
  options: PathNormalizationOptions = {},
): PathNormalizationResult {
  const maxDeviationPx = options.maxDeviationPx ?? 0.01;
  const scale = Math.max(options.transformScale ?? 1, Number.EPSILON);
  const localTolerance = maxDeviationPx / scale;
  const tokens = tokenize(sourcePathData);
  const output: string[] = [];
  let index = 0;
  let command = '';
  let current: Point = { x: 0, y: 0 };
  let subpathStart: Point = { x: 0, y: 0 };
  let previousCubicControl: Point | null = null;
  let previousQuadraticControl: Point | null = null;
  let generatedCubicSegments = 0;

  while (index < tokens.length) {
    if (isCommand(tokens[index])) command = tokens[index++];
    if (!command) throw new Error('SVG path must begin with a command.');
    const uppercase = command.toUpperCase();
    const relative = command !== uppercase;
    const arity = ARGUMENTS[uppercase];
    if (arity === undefined) throw new Error(`Unsupported SVG command: ${command}`);

    if (uppercase === 'Z') {
      output.push('Z');
      current = { ...subpathStart };
      previousCubicControl = null;
      previousQuadraticControl = null;
      command = '';
      continue;
    }

    let firstMove = true;
    do {
      if (index + arity > tokens.length || tokens.slice(index, index + arity).some(isCommand)) {
        throw new Error(`SVG command ${command} is missing arguments.`);
      }
      const values = tokens.slice(index, index + arity).map(Number);
      index += arity;
      const point = (x: number, y: number): Point => relative ? { x: current.x + x, y: current.y + y } : { x, y };

      switch (uppercase) {
        case 'M': {
          const destination = point(values[0], values[1]);
          output.push(format(firstMove ? 'M' : 'L', [destination.x, destination.y]));
          if (firstMove) subpathStart = { ...destination };
          current = destination;
          previousCubicControl = null;
          previousQuadraticControl = null;
          break;
        }
        case 'L':
          current = point(values[0], values[1]);
          output.push(format('L', [current.x, current.y]));
          previousCubicControl = null;
          previousQuadraticControl = null;
          break;
        case 'H':
          current = { x: relative ? current.x + values[0] : values[0], y: current.y };
          output.push(format('L', [current.x, current.y]));
          previousCubicControl = null;
          previousQuadraticControl = null;
          break;
        case 'V':
          current = { x: current.x, y: relative ? current.y + values[0] : values[0] };
          output.push(format('L', [current.x, current.y]));
          previousCubicControl = null;
          previousQuadraticControl = null;
          break;
        case 'C': {
          const control1 = point(values[0], values[1]);
          const control2 = point(values[2], values[3]);
          current = point(values[4], values[5]);
          output.push(format('C', [control1.x, control1.y, control2.x, control2.y, current.x, current.y]));
          previousCubicControl = control2;
          previousQuadraticControl = null;
          break;
        }
        case 'S': {
          const control1 = previousCubicControl ? reflect(previousCubicControl, current) : { ...current };
          const control2 = point(values[0], values[1]);
          current = point(values[2], values[3]);
          output.push(format('C', [control1.x, control1.y, control2.x, control2.y, current.x, current.y]));
          previousCubicControl = control2;
          previousQuadraticControl = null;
          break;
        }
        case 'Q': {
          const control = point(values[0], values[1]);
          current = point(values[2], values[3]);
          output.push(format('Q', [control.x, control.y, current.x, current.y]));
          previousQuadraticControl = control;
          previousCubicControl = null;
          break;
        }
        case 'T': {
          const control: Point = previousQuadraticControl ? reflect(previousQuadraticControl, current) : { ...current };
          current = point(values[0], values[1]);
          output.push(format('Q', [control.x, control.y, current.x, current.y]));
          previousQuadraticControl = control;
          previousCubicControl = null;
          break;
        }
        case 'A': {
          const destination = point(values[5], values[6]);
          const curves = arcToCubics(current, values[0], values[1], values[2], values[3] !== 0, values[4] !== 0, destination, localTolerance);
          if (!curves.length) output.push(format('L', [destination.x, destination.y]));
          for (const curve of curves) {
            output.push(format('C', [curve.control1.x, curve.control1.y, curve.control2.x, curve.control2.y, curve.to.x, curve.to.y]));
            generatedCubicSegments += 1;
          }
          current = destination;
          previousCubicControl = curves.length ? curves[curves.length - 1].control2 : null;
          previousQuadraticControl = null;
          break;
        }
      }
      firstMove = false;
    } while (index < tokens.length && !isCommand(tokens[index]));
  }

  return { sourcePathData, normalizedPathData: output.join(' '), windingRule, maxDeviationPx, generatedCubicSegments };
}

/**
 * Normalize a path for Figma and remove its source-coordinate origin.
 *
 * Figma recalculates a VectorNode's frame when vectorPaths is assigned. Keeping
 * large or negative source coordinates in the path therefore mixes the XD path
 * origin with Figma's auto-generated frame origin. Translating the geometric
 * bounds to (0, 0) makes node x/y the only placement source.
 */
export function normalizeSvgPathToOrigin(
  sourcePathData: string,
  windingRule: 'EVENODD' | 'NONZERO' = 'NONZERO',
  options: PathNormalizationOptions = {},
): PathOriginNormalizationResult {
  const normalized = normalizeSvgPath(sourcePathData, windingRule, options);
  const bounds = measureNormalizedSvgPath(normalized.normalizedPathData);
  return {
    ...normalized,
    originPathData: translateNormalizedSvgPath(normalized.normalizedPathData, -bounds.x, -bounds.y),
    bounds,
  };
}

/** Measure the true curve bounds rather than the wider control-point bounds. */
export function measureSvgPath(
  sourcePathData: string,
  options: PathNormalizationOptions = {},
): SvgPathBounds {
  return measureNormalizedSvgPath(normalizeSvgPath(sourcePathData, 'NONZERO', options).normalizedPathData);
}

function measureNormalizedSvgPath(pathData: string): SvgPathBounds {
  const tokens = tokenize(pathData);
  let index = 0;
  let current: Point = { x: 0, y: 0 };
  let subpathStart: Point = { x: 0, y: 0 };
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  const include = (point: Point): void => {
    minimumX = Math.min(minimumX, point.x);
    minimumY = Math.min(minimumY, point.y);
    maximumX = Math.max(maximumX, point.x);
    maximumY = Math.max(maximumY, point.y);
  };

  while (index < tokens.length) {
    const command = tokens[index++];
    if (!isCommand(command)) throw new Error('Normalized SVG path contains an unexpected value.');
    if (command === 'Z') {
      include(current);
      include(subpathStart);
      current = { ...subpathStart };
      continue;
    }
    const arity = ARGUMENTS[command];
    if (arity === undefined || !['M', 'L', 'Q', 'C'].includes(command) || index + arity > tokens.length) {
      throw new Error(`Path is not in the normalized Figma subset: ${command}`);
    }
    const values = tokens.slice(index, index + arity).map(Number);
    index += arity;

    if (command === 'M') {
      current = { x: values[0], y: values[1] };
      subpathStart = { ...current };
      include(current);
      continue;
    }
    if (command === 'L') {
      include(current);
      current = { x: values[0], y: values[1] };
      include(current);
      continue;
    }
    if (command === 'Q') {
      const from = current;
      const control = { x: values[0], y: values[1] };
      const to = { x: values[2], y: values[3] };
      include(from);
      include(to);
      for (const t of quadraticExtrema(from.x, control.x, to.x)) include(quadraticPoint(from, control, to, t));
      for (const t of quadraticExtrema(from.y, control.y, to.y)) include(quadraticPoint(from, control, to, t));
      current = to;
      continue;
    }

    const from = current;
    const control1 = { x: values[0], y: values[1] };
    const control2 = { x: values[2], y: values[3] };
    const to = { x: values[4], y: values[5] };
    include(from);
    include(to);
    for (const t of cubicExtrema(from.x, control1.x, control2.x, to.x)) include(cubicPoint(from, control1, control2, to, t));
    for (const t of cubicExtrema(from.y, control1.y, control2.y, to.y)) include(cubicPoint(from, control1, control2, to, t));
    current = to;
  }

  if (!Number.isFinite(minimumX)) throw new Error('SVG path has no measurable points.');
  return { x: minimumX, y: minimumY, width: maximumX - minimumX, height: maximumY - minimumY };
}

function translateNormalizedSvgPath(pathData: string, offsetX: number, offsetY: number): string {
  const tokens = tokenize(pathData);
  const output: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    const command = tokens[index++];
    if (!isCommand(command)) throw new Error('Normalized SVG path contains an unexpected value.');
    if (command === 'Z') {
      output.push('Z');
      continue;
    }
    const arity = ARGUMENTS[command];
    if (arity === undefined || !['M', 'L', 'Q', 'C'].includes(command) || index + arity > tokens.length) {
      throw new Error(`Path is not in the normalized Figma subset: ${command}`);
    }
    const values = tokens.slice(index, index + arity).map(Number);
    index += arity;
    for (let valueIndex = 0; valueIndex < values.length; valueIndex += 2) {
      values[valueIndex] += offsetX;
      values[valueIndex + 1] += offsetY;
    }
    output.push(format(command, values));
  }
  return output.join(' ');
}

function quadraticExtrema(from: number, control: number, to: number): number[] {
  const denominator = from - 2 * control + to;
  if (Math.abs(denominator) <= Number.EPSILON) return [];
  const t = (from - control) / denominator;
  return t > 0 && t < 1 ? [t] : [];
}

function cubicExtrema(from: number, control1: number, control2: number, to: number): number[] {
  const a = -from + 3 * control1 - 3 * control2 + to;
  const b = 2 * (from - 2 * control1 + control2);
  const c = control1 - from;
  if (Math.abs(a) <= Number.EPSILON) {
    if (Math.abs(b) <= Number.EPSILON) return [];
    const t = -c / b;
    return t > 0 && t < 1 ? [t] : [];
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  const results = [(-b + root) / (2 * a), (-b - root) / (2 * a)];
  return [...new Set(results.filter((t) => t > 0 && t < 1))];
}

function quadraticPoint(from: Point, control: Point, to: Point, t: number): Point {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
    y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
  };
}

function cubicPoint(from: Point, control1: Point, control2: Point, to: Point, t: number): Point {
  const inverse = 1 - t;
  return {
    x: inverse ** 3 * from.x + 3 * inverse ** 2 * t * control1.x + 3 * inverse * t ** 2 * control2.x + t ** 3 * to.x,
    y: inverse ** 3 * from.y + 3 * inverse ** 2 * t * control1.y + 3 * inverse * t ** 2 * control2.y + t ** 3 * to.y,
  };
}

function tokenize(path: string): string[] {
  const matches = path.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g);
  if (!matches?.length) throw new Error('SVG path is empty.');
  return matches;
}

function isCommand(token: string): boolean {
  return /^[a-zA-Z]$/.test(token);
}

function reflect(control: Point, around: Point): Point {
  return { x: 2 * around.x - control.x, y: 2 * around.y - control.y };
}

function format(command: string, values: number[]): string {
  return `${command} ${values.map((value) => Number(value.toFixed(8)).toString()).join(' ')}`;
}

function arcToCubics(from: Point, radiusX: number, radiusY: number, rotationDegrees: number, largeArc: boolean, sweep: boolean, to: Point, tolerance: number): Cubic[] {
  if (from.x === to.x && from.y === to.y) return [];
  let rx = Math.abs(radiusX);
  let ry = Math.abs(radiusY);
  if (rx === 0 || ry === 0) return [];
  const phi = rotationDegrees % 360 * Math.PI / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  const lambda = x1p ** 2 / rx ** 2 + y1p ** 2 / ry ** 2;
  if (lambda > 1) {
    const factor = Math.sqrt(lambda);
    rx *= factor;
    ry *= factor;
  }
  const numerator = rx ** 2 * ry ** 2 - rx ** 2 * y1p ** 2 - ry ** 2 * x1p ** 2;
  const denominator = rx ** 2 * y1p ** 2 + ry ** 2 * x1p ** 2;
  const coefficient = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
  const centerPrime = { x: coefficient * rx * y1p / ry, y: coefficient * -ry * x1p / rx };
  const center = {
    x: cosPhi * centerPrime.x - sinPhi * centerPrime.y + (from.x + to.x) / 2,
    y: sinPhi * centerPrime.x + cosPhi * centerPrime.y + (from.y + to.y) / 2,
  };
  const unitStart = { x: (x1p - centerPrime.x) / rx, y: (y1p - centerPrime.y) / ry };
  const unitEnd = { x: (-x1p - centerPrime.x) / rx, y: (-y1p - centerPrime.y) / ry };
  const startAngle = Math.atan2(unitStart.y, unitStart.x);
  let delta = vectorAngle(unitStart, unitEnd);
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  if (sweep && delta < 0) delta += Math.PI * 2;
  const maxRadius = Math.max(rx, ry);
  const toleranceAngle = maxRadius <= tolerance ? Math.PI / 2 : Math.min(Math.PI / 2, 2 * Math.acos(Math.max(-1, 1 - tolerance / maxRadius)));
  const segmentCount = Math.max(1, Math.ceil(Math.abs(delta) / Math.max(toleranceAngle, 0.0001)));
  if (segmentCount > 4096) throw new Error('Arc requires more than 4096 segments at the requested tolerance.');
  const step = delta / segmentCount;
  const curves: Cubic[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const theta1 = startAngle + index * step;
    const theta2 = theta1 + step;
    const alpha = 4 / 3 * Math.tan((theta2 - theta1) / 4);
    const start = ellipsePoint(theta1, rx, ry, cosPhi, sinPhi, center);
    const end = ellipsePoint(theta2, rx, ry, cosPhi, sinPhi, center);
    const derivative1 = ellipseDerivative(theta1, rx, ry, cosPhi, sinPhi);
    const derivative2 = ellipseDerivative(theta2, rx, ry, cosPhi, sinPhi);
    curves.push({
      control1: { x: start.x + alpha * derivative1.x, y: start.y + alpha * derivative1.y },
      control2: { x: end.x - alpha * derivative2.x, y: end.y - alpha * derivative2.y },
      to: end,
    });
  }
  return curves;
}

function vectorAngle(left: Point, right: Point): number {
  return Math.atan2(left.x * right.y - left.y * right.x, left.x * right.x + left.y * right.y);
}

function ellipsePoint(theta: number, rx: number, ry: number, cosPhi: number, sinPhi: number, center: Point): Point {
  const x = rx * Math.cos(theta);
  const y = ry * Math.sin(theta);
  return { x: cosPhi * x - sinPhi * y + center.x, y: sinPhi * x + cosPhi * y + center.y };
}

function ellipseDerivative(theta: number, rx: number, ry: number, cosPhi: number, sinPhi: number): Point {
  const x = -rx * Math.sin(theta);
  const y = ry * Math.cos(theta);
  return { x: cosPhi * x - sinPhi * y, y: sinPhi * x + cosPhi * y };
}
