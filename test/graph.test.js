import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../monica.js';

const groups = [
  { id: 1, name: 'love' },
  { id: 2, name: 'family' },
  { id: 3, name: 'friend' },
];
const types = [
  { id: 10, name: 'partner', name_reverse_relationship: 'partner', relationship_type_group_id: 1 },
  { id: 20, name: 'parent', name_reverse_relationship: 'child', relationship_type_group_id: 2 },
  { id: 21, name: 'child', name_reverse_relationship: 'parent', relationship_type_group_id: 2 },
  { id: 30, name: 'friend', name_reverse_relationship: 'friend', relationship_type_group_id: 3 },
];
const contact = (id, name, extra = {}) => ({ id, hash_id: `h${id}`, complete_name: name, is_me: false, ...extra });
const rel = (a, typeId, b) => {
  const t = types.find((x) => x.id === typeId);
  return { contact_is: a, of_contact: b, relationship_type: t };
};

const me = contact(1, 'Me', { is_me: true });
const ann = contact(2, 'Ann');
const bob = contact(3, 'Bob');
const loner = contact(4, 'Loner');

test('creates one node per contact, including contacts with no relationships', () => {
  const { nodes } = buildGraph([me, ann, bob, loner], [], groups);
  assert.deepEqual(nodes.map((n) => n.id).sort(), ['1', '2', '3', '4']);
  assert.equal(nodes.find((n) => n.id === '4').label, 'Loner');
});

test('marks the is_me contact as the central node', () => {
  const { nodes } = buildGraph([me, ann], [], groups);
  assert.equal(nodes.find((n) => n.id === '1').isMe, true);
  assert.equal(nodes.find((n) => n.id === '2').isMe, false);
});

test('collapses a relationship and its reverse row into one edge', () => {
  const rels = [rel(ann, 20, bob), rel(bob, 21, ann)]; // ann parent of bob / bob child of ann
  const { edges } = buildGraph([ann, bob], rels, groups);
  assert.equal(edges.length, 1);
});

test('keeps different relationship types between the same pair as separate edges', () => {
  const rels = [rel(ann, 30, bob), rel(ann, 10, bob)];
  const { edges } = buildGraph([ann, bob], rels, groups);
  assert.equal(edges.length, 2);
});

test('labels an edge with the type name and assigns the category from its type group', () => {
  const { edges } = buildGraph([ann, bob], [rel(ann, 20, bob)], groups);
  assert.equal(edges[0].label, 'parent');
  assert.equal(edges[0].category, 'family');
  assert.equal(edges[0].source, '2');
  assert.equal(edges[0].target, '3');
});

test('ignores relationships whose contacts are not in the contact list', () => {
  const ghost = contact(99, 'Ghost');
  const { edges } = buildGraph([ann], [rel(ann, 30, ghost)], groups);
  assert.equal(edges.length, 0);
});

test('exposes the categories present so a legend can be generated', () => {
  const { categories } = buildGraph([ann, bob], [rel(ann, 30, bob)], groups);
  assert.deepEqual(categories, ['friend']);
});
