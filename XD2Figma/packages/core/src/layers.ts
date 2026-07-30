import type {
  XdDocument,
  XdLayerBounds,
  XdLayerDatabase,
  XdLayerRecord,
  XdNode,
} from './types';

/** Build a complete, auditable XD layer tree with both local and artboard bounds. */
export function createLayerDatabase(document: Pick<XdDocument, 'nodes' | 'artboardGuids'>): XdLayerDatabase {
  const nodes = new Map(document.nodes.map((node) => [node.guid, node]));
  const records: XdLayerRecord[] = [];
  const visited = new Set<string>();

  const visit = (
    node: XdNode,
    parentArtboardX: number,
    parentArtboardY: number,
    zOrder: number,
    path: string[],
  ): void => {
    if (visited.has(node.guid)) throw new Error(`LAYER_DATABASE_CYCLE: ${node.guid}`);
    visited.add(node.guid);
    const isArtboard = node.type === 'ARTBOARD';
    const artboardX = isArtboard ? 0 : parentArtboardX + node.x;
    const artboardY = isArtboard ? 0 : parentArtboardY + node.y;
    const childNodes = node.children.map((guid) => {
      const child = nodes.get(guid);
      if (!child || child.parentGuid !== node.guid) throw new Error(`LAYER_DATABASE_PARENT_MISMATCH: ${guid}`);
      return child;
    });
    const contentBounds = boundsOfChildren(childNodes);
    const nextPath = [...path, node.guid];
    records.push({
      guid: node.guid,
      type: node.type,
      name: node.name,
      parentGuid: node.parentGuid,
      artboardGuid: node.artboardGuid ?? node.guid,
      childGuids: [...node.children],
      zOrder,
      depth: path.length,
      path: nextPath,
      localBounds: bounds(node.x, node.y, node.width, node.height),
      artboardBounds: bounds(artboardX, artboardY, node.width, node.height),
      contentBounds,
    });
    childNodes.forEach((child, index) => visit(child, artboardX, artboardY, index, nextPath));
  };

  for (const [index, guid] of document.artboardGuids.entries()) {
    const artboard = nodes.get(guid);
    if (!artboard || artboard.type !== 'ARTBOARD' || artboard.parentGuid !== null) {
      throw new Error(`LAYER_DATABASE_ARTBOARD_INVALID: ${guid}`);
    }
    visit(artboard, 0, 0, index, []);
  }
  if (records.length !== document.nodes.length) {
    throw new Error(`LAYER_DATABASE_COUNT_MISMATCH: expected=${document.nodes.length} actual=${records.length}`);
  }
  return { schemaVersion: 1, coordinateSpace: 'ARTBOARD_RELATIVE', records };
}

/**
 * Make layers.json authoritative for hierarchy and relative placement.
 * Width and height remain the XD source bounds; Figma content fitting happens
 * later without losing the layer database's artboard-relative audit position.
 */
export function applyLayerDatabase(
  document: Pick<XdDocument, 'nodes' | 'artboardGuids' | 'coordinateSpace' | 'layerDatabaseVersion'>,
  database: XdLayerDatabase,
): void {
  if (database.schemaVersion !== 1 || database.coordinateSpace !== 'ARTBOARD_RELATIVE') {
    throw new Error('LAYER_DATABASE_SCHEMA_UNSUPPORTED');
  }
  const nodes = new Map(document.nodes.map((node) => [node.guid, node]));
  const records = new Map(database.records.map((record) => [record.guid, record]));
  if (records.size !== database.records.length || records.size !== document.nodes.length) {
    throw new Error(`LAYER_DATABASE_COUNT_MISMATCH: expected=${document.nodes.length} actual=${records.size}`);
  }

  for (const record of database.records) {
    const node = nodes.get(record.guid);
    if (!node || node.type !== record.type || record.artboardGuid !== (node.artboardGuid ?? node.guid)) {
      throw new Error(`LAYER_DATABASE_SOURCE_MISMATCH: ${record.guid}`);
    }
    if (record.path.at(-1) !== record.guid || record.depth !== record.path.length - 1) {
      throw new Error(`LAYER_DATABASE_PATH_INVALID: ${record.guid}`);
    }
    if (record.parentGuid === null) {
      if (record.type !== 'ARTBOARD' || record.artboardBounds.x !== 0 || record.artboardBounds.y !== 0) {
        throw new Error(`LAYER_DATABASE_ARTBOARD_INVALID: ${record.guid}`);
      }
    } else {
      const parent = records.get(record.parentGuid);
      if (!parent || record.path.at(-2) !== parent.guid || record.artboardGuid !== parent.artboardGuid) {
        throw new Error(`LAYER_DATABASE_PARENT_MISMATCH: ${record.guid}`);
      }
      const expectedX = parent.type === 'ARTBOARD'
        ? record.artboardBounds.x
        : record.artboardBounds.x - parent.artboardBounds.x;
      const expectedY = parent.type === 'ARTBOARD'
        ? record.artboardBounds.y
        : record.artboardBounds.y - parent.artboardBounds.y;
      assertNumberClose(record.localBounds.x, expectedX, 'x', record.guid);
      assertNumberClose(record.localBounds.y, expectedY, 'y', record.guid);
    }
    node.parentGuid = record.parentGuid;
    node.children = [...record.childGuids];
    if (node.type !== 'ARTBOARD') {
      node.x = record.localBounds.x;
      node.y = record.localBounds.y;
    }
  }

  for (const record of database.records) {
    for (const [index, childGuid] of record.childGuids.entries()) {
      const child = records.get(childGuid);
      if (!child || child.parentGuid !== record.guid || child.zOrder !== index) {
        throw new Error(`LAYER_DATABASE_Z_ORDER_MISMATCH: ${childGuid}`);
      }
    }
  }
  const roots = database.records.filter((record) => record.parentGuid === null).map((record) => record.guid);
  if (roots.length !== document.artboardGuids.length || roots.some((guid, index) => guid !== document.artboardGuids[index])) {
    throw new Error('LAYER_DATABASE_ARTBOARD_ORDER_MISMATCH');
  }
  document.coordinateSpace = 'FIGMA_PARENT_LOCAL_FROM_ARTBOARD_V1';
  document.layerDatabaseVersion = 1;
}

export function layerRecordMap(database: XdLayerDatabase): Map<string, XdLayerRecord> {
  return new Map(database.records.map((record) => [record.guid, record]));
}

function boundsOfChildren(children: XdNode[]): XdLayerBounds | null {
  if (!children.length) return null;
  const minX = Math.min(...children.map((child) => child.x));
  const minY = Math.min(...children.map((child) => child.y));
  const maxX = Math.max(...children.map((child) => child.x + child.width));
  const maxY = Math.max(...children.map((child) => child.y + child.height));
  return bounds(minX, minY, maxX - minX, maxY - minY);
}

function bounds(x: number, y: number, width: number, height: number): XdLayerBounds {
  for (const value of [x, y, width, height]) {
    if (!Number.isFinite(value)) throw new Error('LAYER_DATABASE_NUMBER_INVALID');
  }
  return { x, y, width, height };
}

function assertNumberClose(actual: number, expected: number, field: string, guid: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 0.0001) {
    throw new Error(`LAYER_DATABASE_COORDINATE_MISMATCH: ${field}=${guid} expected=${expected} actual=${actual}`);
  }
}
