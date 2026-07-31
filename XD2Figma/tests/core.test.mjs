import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  createStoredZip,
  createPlainTextDocument,
  createLayerDatabase,
  createDocumentFingerprintAccumulator,
  crc32,
  encodeCoordinateCsv,
  estimateXdTextFallbackGeometry,
  extractImageMetadata,
  fatal,
  figmaRotationFromXdDegrees,
  fingerprintDocument,
  normalizeSvgPath,
  parseCoordinateCsv,
  applyArtboardCoordinates,
  applyLayerDatabase,
  buildOutputFolderName,
  formatDateStamp,
  nextOutputTestNumber,
  normalizeCharactersForFigma,
  normalizePortableBlendMode,
  normalizeSvgPathToOrigin,
  applyPlainTextDocument,
  readZipCentralDirectory,
  resolveXdTextStyleRanges,
  sanitizeOutputStem,
  sha256HexSync,
  stableStringify,
  transformLocalOffset,
  validateDocumentLimits,
  xdPointTextAlignmentGeometry,
  xdPointTextBaselineGeometry,
  xdClipPathBounds,
  xdLineGeometry,
  xdPolygonGeometry,
  xdPolygonPointCount,
  xdRotationDegrees,
  xdTextFrameLayoutBox,
  xdTransformPoint,
  transformedVisualBounds,
} = require('../dist/packages/core/src/index.js');

test('SHA-256 matches the published abc vector', () => {
  assert.equal(sha256HexSync('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('stableStringify is canonical and follows JSON omission rules', () => {
  const left = { z: undefined, b: 2, a: { y: undefined, x: 1 }, list: [1, undefined, Number.NaN] };
  const right = { list: [1, null, null], a: { x: 1 }, b: 2 };
  assert.equal(stableStringify(left), '{"a":{"x":1},"b":2,"list":[1,null,null]}');
  assert.equal(stableStringify(left), stableStringify(right));
});

test('fatal issue identifiers are deterministic', () => {
  assert.equal(fatal('BROKEN', 'same', { value: 1 }).id, fatal('BROKEN', 'same', { value: 1 }).id);
  assert.notEqual(fatal('BROKEN', 'same', { value: 1 }).id, fatal('BROKEN', 'different', { value: 1 }).id);
});

test('SVG normalization expands every unsupported Figma path command', () => {
  const result = normalizeSvgPath('M 1 2 h 10 v 5 q 2 2 4 0 t 4 0 c 1 1 2 2 3 3 s 2 2 4 0 a 5 5 0 0 1 10 0 z', 'EVENODD');
  assert.equal(result.windingRule, 'EVENODD');
  assert.doesNotMatch(result.normalizedPathData, /[AHVSTahvst]/);
  assert.match(result.normalizedPathData, /^M /);
  assert.match(result.normalizedPathData, / C /);
  assert.match(result.normalizedPathData, / Q /);
  assert.match(result.normalizedPathData, / Z$/);
  assert.ok(result.generatedCubicSegments > 0);
});

test('vector paths are translated to a zero origin using true curve bounds', () => {
  const result = normalizeSvgPathToOrigin('M 10 20 C 10 120 110 120 110 20');
  assert.deepEqual(result.bounds, { x: 10, y: 20, width: 100, height: 75 });
  assert.match(result.originPathData, /^M 0 0 C 0 100 100 100 100 0$/);

  const measuredAgain = normalizeSvgPathToOrigin(result.originPathData);
  assert.deepEqual(measuredAgain.bounds, { x: 0, y: 0, width: 100, height: 75 });
});

test('XD point-text baseline is converted to a Figma top-edge offset', () => {
  assert.deepEqual(xdPointTextBaselineGeometry(13), { offsetY: -15.6, firstLineHeight: 15.6 });
  assert.deepEqual(xdPointTextBaselineGeometry(15, 26.25), { offsetY: -26.25, firstLineHeight: 26.25 });
});

test('XD auto-height and area text keep their frame top-left coordinates', () => {
  assert.equal(xdTextFrameLayoutBox('positioned'), 'POINT');
  assert.equal(xdTextFrameLayoutBox('autoHeight'), 'AUTO_HEIGHT');
  assert.equal(xdTextFrameLayoutBox('area'), 'AREA');
});

test('XD point-text alignment anchors convert to Figma top-left geometry', () => {
  assert.deepEqual(
    xdPointTextAlignmentGeometry('RIGHT', [-47.625]),
    { offsetX: -47.625, width: 47.625 },
  );
  assert.deepEqual(
    xdPointTextAlignmentGeometry('CENTER', [-13.3835, undefined]),
    { offsetX: -13.3835, width: 26.767 },
  );
  assert.deepEqual(xdPointTextAlignmentGeometry('LEFT', [0]), { offsetX: 0 });
});

test('XD clip-path transform becomes the clipped container origin', () => {
  assert.deepEqual(
    xdClipPathBounds(
      { x: 0, y: 0, width: 523, height: 523 },
      { a: 1, b: 0, c: 0, d: 1, tx: 715, ty: 2386 },
    ),
    { x: 715, y: 2386, width: 523, height: 523 },
  );
  assert.deepEqual(
    xdClipPathBounds(
      { x: 10, y: 20, width: 30, height: 40 },
      { a: 0, b: 1, c: -1, d: 0, tx: 100, ty: 200 },
    ),
    { x: 40, y: 210, width: 40, height: 30 },
  );
});

test('XD AGC polygon point arrays retain their real geometry and corner count', () => {
  const points = [
    { x: 4.800000190734863, y: 0 },
    { x: 9.600000381469727, y: 8 },
    { x: 0, y: 8 },
  ];
  assert.deepEqual(
    xdPolygonGeometry(points, 9.600000381469727, 8),
    {
      x: 0,
      y: 0,
      offsetX: 0,
      offsetY: 0,
      width: 9.600000381469727,
      height: 8,
    },
  );
  assert.equal(xdPolygonPointCount(3, points), 3);
  assert.equal(xdPolygonPointCount(undefined, points), 3);
});

test('XD line endpoints become a normalized vector path instead of a resized Figma LineNode', () => {
  assert.deepEqual(
    xdLineGeometry(250, 2464.5, 250, 2754.4833374023438),
    {
      x: 250,
      y: 2464.5,
      offsetX: 250,
      offsetY: 2464.5,
      width: 0,
      height: 289.98333740234375,
      pathData: 'M 0 0 L 0 289.98333740234375',
    },
  );
  assert.deepEqual(
    xdLineGeometry(20, 5, 10, 25),
    {
      x: 10,
      y: 5,
      offsetX: 10,
      offsetY: 5,
      width: 10,
      height: 20,
      pathData: 'M 10 0 L 0 20',
    },
  );
});

test('rotated vector origin is transformed before final translation', () => {
  const quarterTurn = { a: 0, b: 1, c: -1, d: 0, tx: 100, ty: 200 };
  assert.deepEqual(xdTransformPoint(quarterTurn, { x: 10, y: 20 }), { x: 80, y: 210 });
  assert.equal(xdRotationDegrees(quarterTurn), 90);
  assert.equal(xdRotationDegrees({ a: -1, b: 0, c: 0, d: -1 }), 180);
});

test('XD clockwise rotation maps to Figma with the opposite angle sign', () => {
  assert.equal(figmaRotationFromXdDegrees(90), -90);
  assert.equal(figmaRotationFromXdDegrees(-90), 90);
  assert.equal(figmaRotationFromXdDegrees(180), 180);
  assert.equal(figmaRotationFromXdDegrees(-180), 180);
  assert.equal(figmaRotationFromXdDegrees(360), 0);
});

test('content-fit origin offsets rotate into parent space before translation', () => {
  assert.deepEqual(
    transformLocalOffset(
      [[0, 1, 0], [-1, 0, 0]],
      { x: -4.231500148773193, y: -2.382601261138916 },
    ),
    {
      x: -2.382601261138916,
      y: 4.231500148773193,
    },
  );
});

test('content fitting uses rotated visual bounds and keeps centered strokes inside', () => {
  assert.deepEqual(
    transformedVisualBounds(
      9.600000381469727,
      8,
      [[-1, 0, 169.2998046875], [0, -1, 9]],
    ),
    {
      x: 159.69980430603027,
      y: 1,
      width: 9.600000381469727,
      height: 8,
    },
  );
  assert.deepEqual(
    transformedVisualBounds(
      0.01,
      289.98333740234375,
      [[1, 0, 0], [0, 1, 0]],
      0.5,
    ),
    {
      x: -0.5,
      y: -0.5,
      width: 1.01,
      height: 290.98333740234375,
    },
  );
});

test('stored ZIP round-trips its directory and rejects ambiguous paths', () => {
  const bytes = createStoredZip([
    { name: 'manifest.json', bytes: new TextEncoder().encode('{}') },
    { name: 'assets/a.png', bytes: Uint8Array.from([1, 2, 3]) },
  ]);
  const entries = readZipCentralDirectory(bytes);
  assert.deepEqual(entries.map((entry) => entry.name), ['manifest.json', 'assets/a.png']);
  assert.deepEqual([...bytes.slice(entries[1].dataOffset, entries[1].dataOffset + entries[1].uncompressedSize)], [1, 2, 3]);
  assert.throws(() => createStoredZip([{ name: '../escape', bytes: new Uint8Array() }]), /Unsafe ZIP path/);
  assert.throws(() => createStoredZip([{ name: 'same', bytes: new Uint8Array() }, { name: 'same', bytes: new Uint8Array() }]), /Duplicate ZIP path/);
});

test('raw PNG ICC and EXIF payloads are preserved in audit metadata', () => {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const icc = Uint8Array.from([80, 114, 111, 102, 105, 108, 101, 0, 0, 1, 2, 3]);
  const exif = Uint8Array.from([73, 73, 42, 0, 8, 0, 0, 0]);
  const bytes = concatBytes([signature, pngChunk('iCCP', icc), pngChunk('eXIf', exif), pngChunk('IEND', new Uint8Array())]);
  const metadata = extractImageMetadata(bytes, 'image/png');
  assert.match(metadata.iccProfile, /^png-iCCP;sha256=/);
  assert.equal(metadata.exif.format, 'png-eXIf');
  assert.equal(metadata.exif.rawBase64, 'SUkqAAgAAAA=');
});

test('document fingerprint is independent of node array order but binds semantic values', async () => {
  const nodeA = sampleNode('a', 1);
  const nodeB = sampleNode('b', 2);
  const first = await fingerprintDocument({ artboardGuids: ['b', 'a'], nodes: [nodeA, nodeB] });
  const reordered = await fingerprintDocument({ artboardGuids: ['a', 'b'], nodes: [nodeB, nodeA] });
  const changed = await fingerprintDocument({ artboardGuids: ['a', 'b'], nodes: [nodeB, { ...nodeA, opacity: 0.5 }] });
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});

test('incremental fingerprint matches document fingerprint without retaining nodes', async () => {
  const nodes = Array.from({ length: 2_000 }, (_, index) => sampleNode(`node-${index}`, index));
  const accumulator = createDocumentFingerprintAccumulator();
  for (const node of nodes) accumulator.addNode(node);
  assert.equal(accumulator.nodeCount, nodes.length);
  assert.equal(await accumulator.finish(['artboard']), await fingerprintDocument({ artboardGuids: ['artboard'], nodes }));
});

test('v1 limits reject too many artboards at preflight', () => {
  const document = { artboardGuids: Array.from({ length: 501 }, (_, index) => String(index)), nodes: [], assets: [] };
  const issues = validateDocumentLimits(document, { archive: 0, uncompressed: 0, assets: 0 });
  assert.ok(issues.some((issue) => issue.code === 'PACKAGE_TOO_LARGE'));
});

test('artboard coordinate CSV converts logical XD groups to Figma parent-local positions', () => {
  const artboard = { ...sampleNode('artboard', -24000), type: 'ARTBOARD', artboardGuid: 'artboard', children: ['group'] };
  const group = { ...sampleNode('group', 999), type: 'GROUP', parentGuid: 'artboard', artboardGuid: 'artboard', children: ['text'] };
  const text = { ...sampleNode('text', 888), type: 'TEXT', parentGuid: 'group', artboardGuid: 'artboard' };
  const document = { nodes: [artboard, group, text], artboardGuids: ['artboard'] };
  const encoded = encodeCoordinateCsv([
    { guid: 'artboard', parentGuid: null, artboardGuid: 'artboard', zOrder: 0, artboardX: 0, artboardY: 0 },
    { guid: 'group', parentGuid: 'artboard', artboardGuid: 'artboard', zOrder: 0, artboardX: 100, artboardY: 200 },
    { guid: 'text', parentGuid: 'group', artboardGuid: 'artboard', zOrder: 0, artboardX: 135, artboardY: 250 },
  ]);

  applyArtboardCoordinates(document, parseCoordinateCsv(encoded));
  assert.deepEqual([artboard.x, artboard.y], [-24000, 0]);
  assert.deepEqual([group.x, group.y], [100, 200]);
  assert.deepEqual([text.x, text.y], [35, 50]);
  assert.equal(document.coordinateSpace, 'FIGMA_PARENT_LOCAL_FROM_ARTBOARD_V1');
});

test('layer database preserves hierarchy paths and restores parent-local positions', () => {
  const artboard = { ...sampleNode('artboard', -24000), type: 'ARTBOARD', artboardGuid: 'artboard', children: ['group'] };
  const group = { ...sampleNode('group', 100), type: 'GROUP', parentGuid: 'artboard', artboardGuid: 'artboard', y: 200, width: 300, height: 100, children: ['text'] };
  const text = { ...sampleNode('text', 35), type: 'TEXT', parentGuid: 'group', artboardGuid: 'artboard', y: 50, width: 80, height: 20 };
  const document = { nodes: [artboard, group, text], artboardGuids: ['artboard'] };
  const database = createLayerDatabase(document);
  const textRecord = database.records.find((record) => record.guid === 'text');
  assert.deepEqual(textRecord.path, ['artboard', 'group', 'text']);
  assert.deepEqual(textRecord.artboardBounds, { x: 135, y: 250, width: 80, height: 20 });
  assert.deepEqual(database.records.find((record) => record.guid === 'group').contentBounds, { x: 35, y: 50, width: 80, height: 20 });

  group.x = 999;
  group.y = 999;
  text.x = 888;
  text.y = 888;
  applyLayerDatabase(document, database);
  assert.deepEqual([group.x, group.y], [100, 200]);
  assert.deepEqual([text.x, text.y], [35, 50]);
  assert.equal(document.layerDatabaseVersion, 1);
});

test('output folders follow date_document_testNN naming and increment per document', () => {
  const date = new Date(2026, 6, 21, 12, 0, 0);
  assert.equal(formatDateStamp(date), '20260721');
  assert.equal(sanitizeOutputStem('220802_冬夏.xd'), '220802_冬夏');
  assert.equal(sanitizeOutputStem('bad/name: draft.xd'), 'bad_name_draft');
  const entries = ['20260721_220802_冬夏_test01', '20260721_220802_冬夏_test02', '20260721_other_test09'];
  assert.equal(nextOutputTestNumber(entries, '20260721', '220802_冬夏.xd'), 3);
  assert.equal(buildOutputFolderName('20260721', '220802_冬夏.xd', 3), '20260721_220802_冬夏_test03');
});

test('XD trailing text inherits the final style range instead of Figma defaults', () => {
  const light18 = textRange(1, 18, 'Light');
  const resolved = resolveXdTextStyleRanges('ABOUT', [light18]);
  assert.deepEqual(resolved.map(({ start, end, sourceIndex, extendedToTextEnd }) => ({ start, end, sourceIndex, extendedToTextEnd })), [
    { start: 0, end: 5, sourceIndex: 0, extendedToTextEnd: true },
  ]);
  assert.equal(resolved[0].range, light18);
});

test('XD text range resolution clamps overlong ranges and extends only the last range', () => {
  const first = textRange(2, 15, 'Regular');
  const last = textRange(1, 15, 'Bold');
  const resolved = resolveXdTextStyleRanges('abcdef', [first, last]);
  assert.deepEqual(resolved.map(({ start, end, sourceIndex, extendedToTextEnd }) => ({ start, end, sourceIndex, extendedToTextEnd })), [
    { start: 0, end: 2, sourceIndex: 0, extendedToTextEnd: false },
    { start: 2, end: 6, sourceIndex: 1, extendedToTextEnd: true },
  ]);
  assert.deepEqual(resolveXdTextStyleRanges('abc', [textRange(99, 12, 'Regular')]).map(({ start, end }) => ({ start, end })), [{ start: 0, end: 3 }]);
});

test('XD blend mode spellings normalize to Figma-compatible values', () => {
  assert.equal(normalizePortableBlendMode('pass-through'), 'PASS_THROUGH');
  assert.equal(normalizePortableBlendMode('soft light'), 'SOFT_LIGHT');
  assert.equal(normalizePortableBlendMode('multiply'), 'MULTIPLY');
  assert.equal(normalizePortableBlendMode('unsupported-mode'), null);
});

test('Figma display text replaces each XD CR one-for-one without mutating the source', () => {
  const source = 'first\n\rsecond\rthird';
  const display = normalizeCharactersForFigma(source);
  assert.equal(display, 'first\n\nsecond\nthird');
  assert.equal(display.length, source.length);
  assert.equal(source, 'first\n\rsecond\rthird');
});

test('point-text fallback geometry uses maximum line length and counts CR/LF independently', () => {
  const fallback = estimateXdTextFallbackGeometry('12345\r12\n\r123', 10, 12);
  assert.ok(Math.abs(fallback.width - 29) < 1e-9);
  assert.deepEqual(
    { height: fallback.height, lineCount: fallback.lineCount, maxLineLength: fallback.maxLineLength },
    { height: 48, lineCount: 4, maxLineLength: 5 },
  );

  const explicit = estimateXdTextFallbackGeometry('long fallback text', 10, 12, 321, 44);
  assert.deepEqual(explicit, { width: 321, height: 44, lineCount: 1, maxLineLength: 18 });
});

test('plain-text JSON contains no font metadata and overrides semantic text by GUID', () => {
  const text = {
    ...sampleNode('text-1', 0),
    type: 'TEXT',
    text: {
      characters: 'semantic value',
      styleRanges: [textRange(14, 20, 'Bold')],
      layoutBox: 'POINT',
      textAlign: 'LEFT',
    },
  };
  const document = { nodes: [text] };
  const extracted = createPlainTextDocument(document);
  assert.deepEqual(extracted, { schemaVersion: 1, texts: [{ guid: 'text-1', characters: 'semantic value' }] });
  assert.doesNotMatch(JSON.stringify(extracted), /font|style|size/i);
  const result = applyPlainTextDocument(document, { schemaVersion: 1, texts: [{ guid: 'text-1', characters: '独立抽出した本文' }] });
  assert.deepEqual(result, { textCount: 1, changedCount: 1 });
  assert.equal(text.text.characters, '独立抽出した本文');
  assert.throws(() => applyPlainTextDocument(document, { schemaVersion: 1, texts: [] }), /PLAIN_TEXT_MISSING_GUIDS/);
});

function sampleNode(guid, x) {
  return {
    guid,
    type: 'RECTANGLE',
    name: guid,
    parentGuid: null,
    artboardGuid: guid,
    children: [],
    x,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    visible: true,
    locked: false,
    opacity: 1,
  };
}

function textRange(length, fontSize, fontStyle) {
  return {
    length,
    fontFamily: 'Noto Sans',
    fontStyle,
    fontSize,
    charSpacing: 0,
    underline: false,
    strikethrough: false,
    textTransform: 'none',
    textScript: 'none',
  };
}

function pngChunk(type, payload) {
  const typeBytes = new TextEncoder().encode(type);
  const output = new Uint8Array(12 + payload.length);
  write32be(output, 0, payload.length);
  output.set(typeBytes, 4);
  output.set(payload, 8);
  write32be(output, 8 + payload.length, crc32(concatBytes([typeBytes, payload])));
  return output;
}

function write32be(bytes, offset, value) {
  bytes[offset] = value >>> 24;
  bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8;
  bytes[offset + 3] = value;
}

function concatBytes(parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
