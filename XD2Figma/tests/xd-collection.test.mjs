import assert from 'node:assert/strict';
import test from 'node:test';
import { collectionToArray, forEachCollection } from '../dist/apps/xd-exporter/src/collection.js';

test('collectionToArray traverses an XD-style SceneNodeList without numeric properties', () => {
  const nodes = [{ guid: 'one' }, { guid: 'two' }];
  const sceneNodeList = {
    length: nodes.length,
    at(index) {
      return nodes[index] ?? null;
    },
    forEach(callback) {
      nodes.forEach(callback);
    },
    map(callback) {
      return nodes.map(callback);
    },
  };

  assert.deepEqual(Array.from(sceneNodeList), [undefined, undefined]);
  assert.deepEqual(collectionToArray(sceneNodeList), nodes);
});

test('collectionToArray supports at-only collections and removes empty entries', () => {
  const collection = {
    length: 3,
    at(index) {
      return ['first', undefined, 'third'][index] ?? null;
    },
  };

  assert.deepEqual(collectionToArray(collection), ['first', 'third']);
});

test('collectionToArray supports arrays, iterables, and empty values', () => {
  assert.deepEqual(collectionToArray([1, undefined, 2]), [1, 2]);
  assert.deepEqual(collectionToArray(new Set(['a', 'b'])), ['a', 'b']);
  assert.deepEqual(collectionToArray(null), []);
});

test('forEachCollection uses XD direct iteration without creating a mapped copy', () => {
  const visited = [];
  const collection = {
    forEach(callback) { ['a', 'b', 'c'].forEach(callback); },
    map() { throw new Error('map must not be used'); },
  };
  forEachCollection(collection, (value) => visited.push(value));
  assert.deepEqual(visited, ['a', 'b', 'c']);
});
