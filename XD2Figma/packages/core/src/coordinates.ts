import type { XdCoordinateRecord, XdDocument, XdNode } from './types';

export const COORDINATE_CSV_HEADER = 'guid,parentGuid,artboardGuid,zOrder,artboardX,artboardY';

export function encodeCoordinateCsvRow(record: XdCoordinateRecord): string {
  return [
    record.guid,
    record.parentGuid ?? '',
    record.artboardGuid,
    String(record.zOrder),
    formatNumber(record.artboardX),
    formatNumber(record.artboardY),
  ].map(csvCell).join(',');
}

export function encodeCoordinateCsv(records: XdCoordinateRecord[]): string {
  return `${COORDINATE_CSV_HEADER}\n${records.map(encodeCoordinateCsvRow).join('\n')}\n`;
}

export function parseCoordinateCsv(value: string): XdCoordinateRecord[] {
  const lines = value.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.shift() !== COORDINATE_CSV_HEADER) throw new Error('COORDINATE_SCHEMA_UNSUPPORTED');
  const records: XdCoordinateRecord[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const cells = parseCsvLine(line);
    if (cells.length !== 6) throw new Error(`COORDINATE_ROW_INVALID: ${line.slice(0, 120)}`);
    const [guid, parentGuid, artboardGuid, rawZOrder, rawX, rawY] = cells;
    const zOrder = Number(rawZOrder);
    const artboardX = Number(rawX);
    const artboardY = Number(rawY);
    if (!guid || !artboardGuid || seen.has(guid) || !Number.isInteger(zOrder) || zOrder < 0 || !Number.isFinite(artboardX) || !Number.isFinite(artboardY)) {
      throw new Error(`COORDINATE_ROW_INVALID: ${guid || '(empty guid)'}`);
    }
    seen.add(guid);
    records.push({ guid, parentGuid: parentGuid || null, artboardGuid, zOrder, artboardX, artboardY });
  }
  return records;
}

/** Convert artboard-relative audit coordinates to Figma parent-local x/y. */
export function applyArtboardCoordinates(document: Pick<XdDocument, 'nodes' | 'artboardGuids' | 'coordinateSpace'>, records: XdCoordinateRecord[]): void {
  const nodes = new Map(document.nodes.map((node) => [node.guid, node]));
  const coordinates = new Map(records.map((record) => [record.guid, record]));
  if (coordinates.size !== document.nodes.length) {
    throw new Error(`COORDINATE_COUNT_MISMATCH: expected=${document.nodes.length} actual=${coordinates.size}`);
  }

  for (const node of document.nodes) {
    const coordinate = coordinates.get(node.guid);
    if (!coordinate || coordinate.artboardGuid !== (node.artboardGuid ?? node.guid)) throw new Error(`COORDINATE_SOURCE_MISMATCH: ${node.guid}`);
    if (node.type === 'ARTBOARD') {
      if (coordinate.parentGuid !== null || coordinate.artboardX !== 0 || coordinate.artboardY !== 0) throw new Error(`COORDINATE_ARTBOARD_INVALID: ${node.guid}`);
      continue;
    }
    if (coordinate.parentGuid !== node.parentGuid || !node.parentGuid) throw new Error(`COORDINATE_PARENT_MISMATCH: ${node.guid}`);
    const parent = nodes.get(node.parentGuid);
    const parentCoordinate = coordinates.get(node.parentGuid);
    if (!parent || !parentCoordinate) throw new Error(`COORDINATE_PARENT_MISSING: ${node.guid}`);
    const expectedZOrder = parent.children.indexOf(node.guid);
    if (expectedZOrder < 0 || expectedZOrder !== coordinate.zOrder) throw new Error(`COORDINATE_Z_ORDER_MISMATCH: ${node.guid}`);
    const parentX = parent.type === 'ARTBOARD' ? 0 : parentCoordinate.artboardX;
    const parentY = parent.type === 'ARTBOARD' ? 0 : parentCoordinate.artboardY;
    node.x = coordinate.artboardX - parentX;
    node.y = coordinate.artboardY - parentY;
  }
  document.coordinateSpace = 'FIGMA_PARENT_LOCAL_FROM_ARTBOARD_V1';
}

/** Build audit coordinates for adapters that already emit parent-local x/y. */
export function deriveArtboardCoordinates(nodes: XdNode[]): XdCoordinateRecord[] {
  const byGuid = new Map(nodes.map((node) => [node.guid, node]));
  const records: XdCoordinateRecord[] = [];
  const visit = (node: XdNode, artboardX: number, artboardY: number, zOrder: number): void => {
    const isArtboard = node.type === 'ARTBOARD';
    const x = isArtboard ? 0 : artboardX + node.x;
    const y = isArtboard ? 0 : artboardY + node.y;
    records.push({ guid: node.guid, parentGuid: node.parentGuid, artboardGuid: node.artboardGuid ?? node.guid, zOrder, artboardX: x, artboardY: y });
    node.children.forEach((guid, index) => {
      const child = byGuid.get(guid);
      if (!child) throw new Error(`COORDINATE_SOURCE_MISMATCH: ${guid}`);
      visit(child, x, y, index);
    });
  };
  nodes.filter((node) => node.type === 'ARTBOARD' && node.parentGuid === null).forEach((node, index) => visit(node, 0, 0, index));
  if (records.length !== nodes.length) throw new Error(`COORDINATE_COUNT_MISMATCH: expected=${nodes.length} actual=${records.length}`);
  return records;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted && character === '"' && line[index + 1] === '"') { cell += '"'; index += 1; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (character === ',' && !quoted) { cells.push(cell); cell = ''; continue; }
    cell += character;
  }
  if (quoted) throw new Error(`COORDINATE_ROW_INVALID: ${line.slice(0, 120)}`);
  cells.push(cell);
  return cells;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('COORDINATE_NUMBER_INVALID');
  return Object.is(value, -0) ? '0' : String(value);
}
