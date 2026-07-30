import type { XdDocument } from './types';

export const PLAIN_TEXT_SCHEMA_VERSION = 1;

/**
 * Font, layout, color, and coordinate metadata are intentionally excluded.
 * guid is the minimum key required to map an exact string back to its node.
 */
export interface XdPlainTextRecord {
  guid: string;
  characters: string;
}

export interface XdPlainTextDocument {
  schemaVersion: typeof PLAIN_TEXT_SCHEMA_VERSION;
  texts: XdPlainTextRecord[];
}

export interface PlainTextApplyResult {
  textCount: number;
  changedCount: number;
}

export function createPlainTextDocument(document: Pick<XdDocument, 'nodes'>): XdPlainTextDocument {
  return {
    schemaVersion: PLAIN_TEXT_SCHEMA_VERSION,
    texts: document.nodes
      .filter((node) => node.type === 'TEXT' && node.text)
      .map((node) => ({ guid: node.guid, characters: node.text!.characters })),
  };
}

/** Apply the separately extracted text as the canonical string source. */
export function applyPlainTextDocument(
  document: Pick<XdDocument, 'nodes'>,
  plainText: XdPlainTextDocument,
): PlainTextApplyResult {
  if (plainText.schemaVersion !== PLAIN_TEXT_SCHEMA_VERSION || !Array.isArray(plainText.texts)) {
    throw new Error(`PLAIN_TEXT_SCHEMA_UNSUPPORTED: ${String(plainText.schemaVersion)}`);
  }

  const textNodes = new Map(
    document.nodes
      .filter((node) => node.type === 'TEXT' && node.text)
      .map((node) => [node.guid, node] as const),
  );
  const seen = new Set<string>();
  let changedCount = 0;
  for (const record of plainText.texts) {
    if (!record || typeof record.guid !== 'string' || typeof record.characters !== 'string') {
      throw new Error('PLAIN_TEXT_INVALID_RECORD');
    }
    if (seen.has(record.guid)) throw new Error(`PLAIN_TEXT_DUPLICATE_GUID: ${record.guid}`);
    seen.add(record.guid);
    const node = textNodes.get(record.guid);
    if (!node?.text) throw new Error(`PLAIN_TEXT_UNKNOWN_GUID: ${record.guid}`);
    if (node.text.characters !== record.characters) changedCount += 1;
    node.text.characters = record.characters;
  }

  const missing = [...textNodes.keys()].filter((guid) => !seen.has(guid));
  if (missing.length) throw new Error(`PLAIN_TEXT_MISSING_GUIDS: ${missing.slice(0, 10).join(',')}${missing.length > 10 ? ` (+${missing.length - 10})` : ''}`);
  return { textCount: textNodes.size, changedCount };
}
