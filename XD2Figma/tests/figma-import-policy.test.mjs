import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectRequestedFonts,
  createFontResolutionCandidates,
} from '../dist/apps/figma-importer/src/font-resolution.js';
import {
  IMPORT_POLICY,
  aggregateBestEffortIssues,
  asBestEffortIssue,
} from '../dist/apps/figma-importer/src/import-policy.js';
import { IMPORT_PAGES } from '../dist/apps/figma-importer/src/import-page-policy.js';
import {
  pointTextPositionX,
  pointTextPositionY,
  pointTextSizingPlan,
} from '../dist/apps/figma-importer/src/text-import-policy.js';

test('import creates exactly one XD Screens page', () => {
  assert.deepEqual(IMPORT_PAGES, [{ name: 'XD Screens', role: 'screens' }]);
});

test('point text hugs rendered glyphs before anchor placement', () => {
  assert.deepEqual(pointTextSizingPlan(240), { textAutoResize: 'WIDTH_AND_HEIGHT', width: null });
  assert.deepEqual(pointTextSizingPlan(undefined), { textAutoResize: 'WIDTH_AND_HEIGHT', width: null });
  assert.deepEqual(pointTextSizingPlan(Number.NaN), { textAutoResize: 'WIDTH_AND_HEIGHT', width: null });
  assert.deepEqual(pointTextSizingPlan(0), { textAutoResize: 'WIDTH_AND_HEIGHT', width: null });
});

test('legacy direct point-text anchors are corrected without double-adjusting new packages', () => {
  assert.equal(pointTextPositionX(1177, 47.625, 'RIGHT', undefined, true), 1129.375);
  assert.equal(pointTextPositionX(194, 26.767, 'CENTER', undefined, true), 180.6165);
  assert.equal(pointTextPositionX(1129.375, 50, 'RIGHT', 'TOP_LEFT', true, -47.625), 1127);
  assert.equal(pointTextPositionX(180.6165, 30, 'CENTER', 'TOP_LEFT', true, -13.3835), 179);
  assert.equal(pointTextPositionX(1129.375, 47.625, 'RIGHT', 'TOP_LEFT', true), 1129.375);
  assert.equal(pointTextPositionX(1177, 47.625, 'RIGHT', undefined, false), 1177);
});

test('point-text y preserves the XD baseline using Figma measured font metrics', () => {
  // XD NO.1: baseline 16, estimated XD top 0.4; Figma Roboto baseline is 12.
  assert.equal(pointTextPositionY(0.4, 12, 'TOP_LEFT', -15.6), 4);
  // XD 朝: baseline 36, estimated XD top 9.75; Figma Noto Sans JP baseline is 19.
  assert.equal(pointTextPositionY(9.75, 19, 'TOP_LEFT', -26.25), 17);
  assert.equal(pointTextPositionY(9.75, undefined, 'TOP_LEFT', -26.25), 9.75);
  assert.equal(pointTextPositionY(9.75, 19, undefined, -26.25), 9.75);
});

test('best-effort policy downgrades compatibility blockers without losing audit severity', () => {
  const issue = asBestEffortIssue({
    id: 'mask-1',
    scope: 'node',
    severity: 'blocker',
    code: 'MASK_UNSUPPORTED',
    message: 'Mask is not supported.',
    artboardGuids: ['artboard-1'],
    nodeGuids: ['node-1'],
    allowedActions: [],
  });

  assert.equal(issue.severity, 'warning');
  assert.equal(issue.details.originalSeverity, 'blocker');
  assert.equal(issue.details.importPolicy, IMPORT_POLICY);
  assert.deepEqual(issue.artboardGuids, ['artboard-1']);
  assert.deepEqual(issue.nodeGuids, ['node-1']);
});

test('best-effort issues aggregate repeated node findings while retaining GUID coverage', () => {
  const base = {
    scope: 'node', severity: 'blocker', code: 'MASK_UNSUPPORTED', message: 'Mask is not supported.',
    allowedActions: [],
  };
  const issues = aggregateBestEffortIssues([
    asBestEffortIssue({ ...base, id: 'mask-1', artboardGuids: ['a-1'], nodeGuids: ['n-1'] }),
    asBestEffortIssue({ ...base, id: 'mask-2', artboardGuids: ['a-1'], nodeGuids: ['n-2'] }),
    asBestEffortIssue({ ...base, id: 'mask-3', artboardGuids: ['a-2'], nodeGuids: ['n-3'] }),
  ]);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].details.occurrences, 3);
  assert.deepEqual(issues[0].artboardGuids, ['a-1', 'a-2']);
  assert.deepEqual(issues[0].nodeGuids, ['n-1', 'n-2', 'n-3']);
});

test('font resolution preserves an exact installed source face', () => {
  const candidates = createFontResolutionCandidates(
    { family: 'Source Sans', style: 'Semibold' },
    [
      { family: 'Noto Sans', style: 'Regular' },
      { family: 'Source Sans', style: 'Semibold' },
    ],
  );

  assert.deepEqual(candidates[0], {
    fontName: { family: 'Source Sans', style: 'Semibold' },
    reason: 'exact',
  });
});

test('missing fonts resolve to the closest Noto Sans style', () => {
  const available = [
    { family: 'Noto Sans', style: 'Regular' },
    { family: 'Noto Sans', style: 'Light' },
    { family: 'Noto Sans', style: 'Medium' },
    { family: 'Inter', style: 'Regular' },
  ];

  const light = createFontResolutionCandidates({ family: 'Rotis Semi Sans Std', style: '45 Light' }, available)[0];
  const medium = createFontResolutionCandidates({ family: 'YuGothic', style: 'Medium' }, available)[0];
  assert.deepEqual(light, { fontName: { family: 'Noto Sans', style: 'Light' }, reason: 'noto-sans' });
  assert.deepEqual(medium, { fontName: { family: 'Noto Sans', style: 'Medium' }, reason: 'noto-sans' });
});

test('Noto Sans regional family is preferred before a non-Noto last resort', () => {
  const candidates = createFontResolutionCandidates(
    { family: 'Missing Japanese Font', style: 'Bold' },
    [
      { family: 'Inter', style: 'Bold' },
      { family: 'Noto Sans JP', style: 'Bold' },
    ],
  );

  assert.deepEqual(candidates[0], {
    fontName: { family: 'Noto Sans JP', style: 'Bold' },
    reason: 'noto-sans',
  });
});

test('Japanese source families prefer Noto Sans JP/CJK JP over generic Noto Sans', () => {
  const available = [
    { family: 'Noto Sans', style: 'Medium' },
    { family: 'Noto Sans CJK JP', style: 'Medium' },
    { family: 'Noto Sans JP', style: 'Medium' },
  ];

  assert.deepEqual(
    createFontResolutionCandidates({ family: 'YuGothic', style: 'Medium' }, available)[0],
    { fontName: { family: 'Noto Sans JP', style: 'Medium' }, reason: 'noto-sans' },
  );
  assert.deepEqual(
    createFontResolutionCandidates({ family: 'Rotis Semi Sans Std', style: 'Medium' }, available)[0],
    { fontName: { family: 'Noto Sans', style: 'Medium' }, reason: 'noto-sans' },
  );
});

test('font audit and text ranges are both included in preflight resolution', () => {
  const requested = collectRequestedFonts({
    fonts: [{
      family: 'Audit Font', style: 'Regular', postscriptName: null, version: null,
      vendor: null, license: null, fsType: null, fileSha256: null, nodeGuids: ['text-1'],
    }],
    nodes: [{
      guid: 'text-1', type: 'TEXT', name: 'Text', parentGuid: 'artboard-1', artboardGuid: 'artboard-1', children: [],
      x: 0, y: 0, width: 100, height: 20, rotation: 0, visible: true, locked: false, opacity: 1,
      text: {
        characters: 'Test', layoutBox: 'POINT', textAlign: 'LEFT',
        styleRanges: [{
          length: 4, fontFamily: 'Range Font', fontStyle: 'Bold', fontSize: 16,
          charSpacing: 0, underline: false, strikethrough: false, textTransform: 'none', textScript: 'none',
        }],
      },
    }],
  });

  assert.deepEqual(requested.map(({ family, style }) => [family, style]), [
    ['Audit Font', 'Regular'],
    ['Range Font', 'Bold'],
  ]);
});
