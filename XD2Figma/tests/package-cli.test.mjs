import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { encodeCoordinateCsv, fingerprintDocument, readZipCentralDirectory, sha256HexSync } = require('../dist/packages/core/src/index.js');

test('package CLI normalizes paths and binds original image bytes by SHA-256', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xd2fig-test-'));
  const assetsDirectory = join(directory, 'assets');
  await mkdir(assetsDirectory);
  const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  await writeFile(join(assetsDirectory, 'hero.png'), imageBytes);
  const artboard = node('artboard', 'ARTBOARD', null, ['group', 'image']);
  const group = { ...node('group', 'GROUP', 'artboard', ['path']), artboardGuid: 'artboard', x: 999, y: 999 };
  const path = { ...node('path', 'PATH', 'group', []), artboardGuid: 'artboard', x: 888, y: 888, sourcePathData: undefined, pathData: 'M0 0 H10 V10 A5 5 0 0 1 0 10 Z' };
  const image = { ...node('image', 'RECTANGLE', 'artboard', []), artboardGuid: 'artboard', assetId: 'hero' };
  const document = {
    documentName: 'Fixture',
    sourceFingerprint: { algorithm: 'sha256', value: '', nodeCount: 4, artboardCount: 1 },
    coordinateSpace: 'XD_SCENEGRAPH_RAW_V1',
    nodes: [artboard, group, path, image],
    artboardGuids: ['artboard'],
    fonts: [],
    assets: [{
      assetId: 'hero',
      path: 'resources/hero.png',
      sha256: sha256HexSync(imageBytes),
      mimeType: 'image/png',
      width: 1,
      height: 1,
      originalFileName: 'hero.png',
      iccProfile: null,
      exif: { orientation: 1 },
      usages: [{ nodeGuid: 'image', artboardGuid: 'artboard' }],
    }, {
      assetId: 'hero-copy',
      path: 'resources/hero.png',
      sha256: sha256HexSync(imageBytes),
      mimeType: 'image/png',
      width: 1,
      height: 1,
      originalFileName: 'hero.png',
      iccProfile: null,
      exif: { orientation: 1 },
      usages: [],
    }],
    references: [],
    issues: [],
  };
  document.sourceFingerprint.value = await fingerprintDocument(document);

  const semanticPath = join(directory, 'semantic.json');
  const outputPath = join(directory, 'fixture.xd2fig');
  await writeFile(semanticPath, JSON.stringify(document));
  await writeFile(join(directory, 'coordinates.csv'), encodeCoordinateCsv([
    { guid: 'artboard', parentGuid: null, artboardGuid: 'artboard', zOrder: 0, artboardX: 0, artboardY: 0 },
    { guid: 'group', parentGuid: 'artboard', artboardGuid: 'artboard', zOrder: 0, artboardX: 100, artboardY: 200 },
    { guid: 'path', parentGuid: 'group', artboardGuid: 'artboard', zOrder: 0, artboardX: 130, artboardY: 240 },
    { guid: 'image', parentGuid: 'artboard', artboardGuid: 'artboard', zOrder: 1, artboardX: 20, artboardY: 30 },
  ]));
  const result = spawnSync(process.execPath, [
    new URL('../dist/tools/package-cli.js', import.meta.url).pathname,
    '--semantic', semanticPath,
    '--assets', assetsDirectory,
    '--out', outputPath,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  const packageBytes = new Uint8Array(await readFile(outputPath));
  const entries = readZipCentralDirectory(packageBytes);
  const names = entries.map((entry) => entry.name);
  assert.ok(names.includes('manifest.json'));
  assert.ok(names.includes('coordinates.csv'));
  assert.ok(names.includes('layers.json'));
  assert.ok(names.includes('texts.json'));
  const packagedAssetPath = `assets/${sha256HexSync(imageBytes)}.png`;
  assert.equal(names.filter((name) => name === packagedAssetPath).length, 1);
  assert.ok(!names.some((name) => name.startsWith('references/')));
  const documentEntry = entries.find((entry) => entry.name === 'document.json');
  const layersEntry = entries.find((entry) => entry.name === 'layers.json');
  assert.ok(documentEntry);
  assert.ok(layersEntry);
  const packaged = JSON.parse(new TextDecoder().decode(packageBytes.slice(documentEntry.dataOffset, documentEntry.dataOffset + documentEntry.uncompressedSize)));
  const layerDatabase = JSON.parse(new TextDecoder().decode(packageBytes.slice(layersEntry.dataOffset, layersEntry.dataOffset + layersEntry.uncompressedSize)));
  const packagedPath = packaged.nodes.find((item) => item.guid === 'path');
  const packagedGroup = packaged.nodes.find((item) => item.guid === 'group');
  assert.equal(packaged.coordinateSpace, 'FIGMA_PARENT_LOCAL_FROM_ARTBOARD_V1');
  assert.deepEqual([packagedGroup.x, packagedGroup.y], [100, 200]);
  assert.deepEqual([packagedPath.x, packagedPath.y], [30, 40]);
  assert.equal(packaged.layerDatabaseVersion, 1);
  assert.deepEqual(layerDatabase.records.find((item) => item.guid === 'path').path, ['artboard', 'group', 'path']);
  assert.deepEqual(layerDatabase.records.find((item) => item.guid === 'path').artboardBounds, { x: 130, y: 240, width: 100, height: 100 });
  assert.equal(packagedPath.sourcePathData, path.pathData);
  assert.doesNotMatch(packagedPath.pathData, /[AHVSTahvst]/);
  assert.equal(packaged.assets[0].exif.orientation, 1);
  assert.equal(packaged.assets[0].sha256, sha256HexSync(imageBytes));
  assert.equal(packaged.assets[1].path, packaged.assets[0].path);
  assert.deepEqual(packaged.references, []);

  const defaultOutputResult = spawnSync(process.execPath, [
    new URL('../dist/tools/package-cli.js', import.meta.url).pathname,
    '--semantic', semanticPath,
    '--assets', assetsDirectory,
  ], { encoding: 'utf8' });
  assert.equal(defaultOutputResult.status, 0, defaultOutputResult.stderr);
  assert.match(defaultOutputResult.stdout, /Fixture\.xd2fig/);
  await readFile(join(directory, 'Fixture.xd2fig'));
});

function node(guid, type, parentGuid, children) {
  return {
    guid,
    type,
    name: guid,
    parentGuid,
    artboardGuid: type === 'ARTBOARD' ? guid : null,
    children,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    visible: true,
    locked: false,
    opacity: 1,
  };
}
