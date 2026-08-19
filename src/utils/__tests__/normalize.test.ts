import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, extractSeasonNumber } from '../normalize.js';

// ── normalizeTitle ───────────────────────────────────────────────────────────

test('normalizeTitle: removes S-notation seasons', () => {
  assert.equal(normalizeTitle('My Hero Academia S7'), 'My Hero Academia');
  assert.equal(normalizeTitle('Demon Slayer S4'), 'Demon Slayer');
  assert.equal(normalizeTitle('Solo Leveling S2'), 'Solo Leveling');
});

test('normalizeTitle: removes Roman numeral seasons', () => {
  assert.equal(normalizeTitle('Overlord IV'), 'Overlord');
  assert.equal(normalizeTitle('Mob Psycho 100 III'), 'Mob Psycho 100');
  assert.equal(normalizeTitle('Sword Art Online II'), 'Sword Art Online');
});

test('normalizeTitle: removes Season N patterns', () => {
  assert.equal(normalizeTitle('My Hero Academia Season 7'), 'My Hero Academia');
  assert.equal(normalizeTitle('Attack on Titan Season 4'), 'Attack on Titan');
});

test('normalizeTitle: removes Part/Cour patterns', () => {
  assert.equal(normalizeTitle('Demon Slayer Part 2'), 'Demon Slayer');
  assert.equal(normalizeTitle('Re:Zero Cour 2'), 'Re:Zero');
});

test('normalizeTitle: removes Final Season patterns', () => {
  assert.equal(normalizeTitle('Attack on Titan The Final Season'), 'Attack on Titan');
  assert.equal(normalizeTitle('My Hero Academia Final Season'), 'My Hero Academia');
});

test('normalizeTitle: preserves integral numbers in titles', () => {
  assert.equal(normalizeTitle('Mob Psycho 100'), 'Mob Psycho 100');
  assert.equal(normalizeTitle('86 Eighty-Six'), '86 Eighty-Six');
});

test('normalizeTitle: removes trailing year in parentheses', () => {
  assert.equal(normalizeTitle('Dune (2024)'), 'Dune');
  assert.equal(normalizeTitle('My Show S2 (2023)'), 'My Show');
});

test('normalizeTitle: leaves titles with no season indicators unchanged', () => {
  assert.equal(normalizeTitle('Frieren: Beyond Journey\'s End'), 'Frieren: Beyond Journey\'s End');
  assert.equal(normalizeTitle('Attack on Titan'), 'Attack on Titan');
});

// ── extractSeasonNumber ──────────────────────────────────────────────────────

test('extractSeasonNumber: extracts from S-notation', () => {
  assert.equal(extractSeasonNumber('My Hero Academia S7'), 7);
  assert.equal(extractSeasonNumber('Demon Slayer S4'), 4);
  assert.equal(extractSeasonNumber('Solo Leveling S2'), 2);
});

test('extractSeasonNumber: extracts Roman numerals', () => {
  assert.equal(extractSeasonNumber('Overlord IV'), 4);
  assert.equal(extractSeasonNumber('Mob Psycho 100 III'), 3);
  assert.equal(extractSeasonNumber('Sword Art Online II'), 2);
});

test('extractSeasonNumber: extracts from Season N', () => {
  assert.equal(extractSeasonNumber('Attack on Titan Season 4'), 4);
  assert.equal(extractSeasonNumber('My Hero Academia Season 7'), 7);
});

test('extractSeasonNumber: extracts from Part N', () => {
  assert.equal(extractSeasonNumber('Demon Slayer Part 2'), 2);
});

test('extractSeasonNumber: returns null when no season present', () => {
  assert.equal(extractSeasonNumber('Frieren: Beyond Journey\'s End'), null);
  assert.equal(extractSeasonNumber('Attack on Titan'), null);
  assert.equal(extractSeasonNumber('Mob Psycho 100'), null);
});
