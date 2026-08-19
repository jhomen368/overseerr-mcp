import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTracked, isFullyAvailable, label } from '../mediaStatus.js';

// ── isTracked ────────────────────────────────────────────────────────────────

test('isTracked: PENDING (2) is tracked', () => {
  assert.equal(isTracked(2), true);
});

test('isTracked: PROCESSING (3) is tracked', () => {
  assert.equal(isTracked(3), true);
});

test('isTracked: PARTIALLY_AVAILABLE (4) is tracked', () => {
  assert.equal(isTracked(4), true);
});

test('isTracked: AVAILABLE (5) is tracked', () => {
  assert.equal(isTracked(5), true);
});

test('isTracked: UNKNOWN (1) is not tracked', () => {
  assert.equal(isTracked(1), false);
});

test('isTracked: DELETED (6) is not tracked', () => {
  assert.equal(isTracked(6), false);
});

test('isTracked: 0 is not tracked', () => {
  assert.equal(isTracked(0), false);
});

// ── isFullyAvailable ─────────────────────────────────────────────────────────

test('isFullyAvailable: AVAILABLE (5) is fully available', () => {
  assert.equal(isFullyAvailable(5), true);
});

test('isFullyAvailable: PARTIALLY_AVAILABLE (4) is not fully available', () => {
  assert.equal(isFullyAvailable(4), false);
});

test('isFullyAvailable: PENDING (2) is not fully available', () => {
  assert.equal(isFullyAvailable(2), false);
});

test('isFullyAvailable: PROCESSING (3) is not fully available', () => {
  assert.equal(isFullyAvailable(3), false);
});

// ── label ────────────────────────────────────────────────────────────────────

test('label: maps known status codes to strings', () => {
  assert.equal(label(1), 'UNKNOWN');
  assert.equal(label(2), 'PENDING');
  assert.equal(label(3), 'PROCESSING');
  assert.equal(label(4), 'PARTIALLY_AVAILABLE');
  assert.equal(label(5), 'AVAILABLE');
  assert.equal(label(6), 'DELETED');
});

test('label: returns UNKNOWN for unrecognised codes', () => {
  assert.equal(label(99), 'UNKNOWN');
  assert.equal(label(0), 'UNKNOWN');
});
