import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleGraph, relationsOf, withAlpha, pickRandomPerson } from '../monica.js';

const node = (id, label, isMe = false) => ({ id, label, isMe });
const edge = (source, target, category, label = 'friend') => ({ id: `${source}-${target}`, source, target, category, label });

const graph = {
  nodes: [node('me', 'Me', true), node('a', 'Ann'), node('b', 'Bob'), node('c', 'Cy'), node('lone', 'Lone')],
  edges: [edge('me', 'a', 'friend'), edge('a', 'b', 'work', 'colleague'), edge('b', 'c', 'family', 'sibling')],
};
const show = (opts) => visibleGraph(graph, { hiddenCategories: new Set(), hideIsolated: false, ...opts });
const ids = (list) => list.map((x) => x.id).sort();

test('keeps everything when nothing is hidden', () => {
  const v = show();
  assert.deepEqual(ids(v.nodes), ['a', 'b', 'c', 'lone', 'me']);
  assert.equal(v.edges.length, 3);
});

test('hides edges in hidden categories but keeps the people', () => {
  const v = show({ hiddenCategories: new Set(['work']) });
  assert.deepEqual(ids(v.edges), ['b-c', 'me-a']);
  assert.equal(v.nodes.length, 5);
});

test('hides people without relationships when asked, but never "me"', () => {
  const v = show({ hideIsolated: true });
  assert.deepEqual(ids(v.nodes), ['a', 'b', 'c', 'me']);
});

test('keeps "me" even when me has no relationships', () => {
  const lonely = { nodes: [node('me', 'Me', true), node('x', 'X')], edges: [] };
  const v = visibleGraph(lonely, { hiddenCategories: new Set(), hideIsolated: true });
  assert.deepEqual(ids(v.nodes), ['me']);
});

test('counts relationships on the full graph, so hiding a category does not make people "isolated"', () => {
  const v = show({ hiddenCategories: new Set(['friend', 'work', 'family']), hideIsolated: true });
  assert.deepEqual(ids(v.nodes), ['a', 'b', 'c', 'me']);
});

test('does not mutate the graph it is given', () => {
  show({ hiddenCategories: new Set(['work']), hideIsolated: true });
  assert.equal(graph.nodes.length, 5);
  assert.equal(graph.edges.length, 3);
});

test('lists a person\'s relationships with the other person\'s name, from either end of the edge', () => {
  assert.deepEqual(relationsOf(graph, 'a'), [
    { kind: 'friend', who: 'Me' },
    { kind: 'colleague', who: 'Bob' },
  ]);
});

test('returns no relationships for someone without any', () => {
  assert.deepEqual(relationsOf(graph, 'lone'), []);
});

test('withAlpha turns hex and rgb colours into rgba', () => {
  assert.equal(withAlpha('#2f6fb0', 0.3), 'rgba(47,111,176,0.3)');
  assert.equal(withAlpha('#fff', 0.5), 'rgba(255,255,255,0.5)');
  assert.equal(withAlpha('rgb(1, 2, 3)', 0.25), 'rgba(1,2,3,0.25)');
});

test('withAlpha returns an unrecognised colour unchanged', () => {
  assert.equal(withAlpha('rebeccapurple', 0.3), 'rebeccapurple');
});

test('pickRandomPerson can pick "me"', () => {
  const people = [node('me', 'Me', true), node('a', 'Ann'), node('b', 'Bob')];
  assert.equal(pickRandomPerson(people, () => 0).id, 'me');
  assert.equal(pickRandomPerson(people, () => 0.5).id, 'a');
  assert.equal(pickRandomPerson(people, () => 0.999).id, 'b');
});

test('pickRandomPerson returns undefined when nobody is visible', () => {
  assert.equal(pickRandomPerson([]), undefined);
});

test('pickRandomPerson stays in range even if random() returns 1', () => {
  assert.equal(pickRandomPerson([node('a', 'Ann'), node('b', 'Bob')], () => 1).id, 'b');
});
