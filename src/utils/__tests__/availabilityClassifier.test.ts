import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAvailability } from '../availabilityClassifier.js';
import type { MediaInfo } from '../../types.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeMediaInfo(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    id: 1,
    tmdbId: 100,
    status: 1,
    requests: [],
    seasons: [],
    ...overrides,
  };
}

function makeRequest(seasonNumbers?: number[]) {
  return {
    id: 99,
    status: 2,
    media: {
      id: 1,
      tmdbId: 100,
      status: 1,
      seasons: seasonNumbers?.map(n => ({ seasonNumber: n, status: 2 })),
    },
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    requestedBy: { id: 1, email: 'test@test.com' },
  };
}

// ── Movie paths ───────────────────────────────────────────────────────────────

test('movie: no mediaInfo → AVAILABLE_FOR_REQUEST', () => {
  const result = classifyAvailability(undefined, 'movie', null);
  assert.equal(result.status, 'pass');
  assert.equal(result.reasonCode, 'AVAILABLE_FOR_REQUEST');
});

test('movie: tracked (status 2) → ALREADY_AVAILABLE', () => {
  const result = classifyAvailability(makeMediaInfo({ status: 2 }), 'movie', null);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'ALREADY_AVAILABLE');
});

test('movie: tracked (status 5) → ALREADY_AVAILABLE', () => {
  const result = classifyAvailability(makeMediaInfo({ status: 5 }), 'movie', null);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'ALREADY_AVAILABLE');
});

test('movie: untracked but has requests → ALREADY_REQUESTED', () => {
  const result = classifyAvailability(
    makeMediaInfo({ status: 1, requests: [makeRequest()] }),
    'movie',
    null
  );
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'ALREADY_REQUESTED');
});

// ── TV: specific season in title ──────────────────────────────────────────────

test('tv + seasonNumber: target season tracked → SEASON_AVAILABLE', () => {
  const result = classifyAvailability(
    makeMediaInfo({ seasons: [{ id: 1, seasonNumber: 2, status: 5, createdAt: '', updatedAt: '' }] }),
    'tv',
    2
  );
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'SEASON_AVAILABLE');
});

test('tv + seasonNumber: target season tracked (PENDING=2) → SEASON_AVAILABLE', () => {
  const result = classifyAvailability(
    makeMediaInfo({ seasons: [{ id: 1, seasonNumber: 1, status: 2, createdAt: '', updatedAt: '' }] }),
    'tv',
    1
  );
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'SEASON_AVAILABLE');
});

test('tv + seasonNumber: target season requested → SEASON_REQUESTED', () => {
  const result = classifyAvailability(
    makeMediaInfo({ requests: [makeRequest([3])] }),
    'tv',
    3
  );
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'SEASON_REQUESTED');
});

test('tv + seasonNumber: target season not tracked or requested → AVAILABLE_FOR_REQUEST', () => {
  const result = classifyAvailability(
    makeMediaInfo({ seasons: [{ id: 1, seasonNumber: 1, status: 5, createdAt: '', updatedAt: '' }] }),
    'tv',
    2
  );
  assert.equal(result.status, 'pass');
  assert.equal(result.reasonCode, 'AVAILABLE_FOR_REQUEST');
});

test('tv + seasonNumber: no mediaInfo → AVAILABLE_FOR_REQUEST', () => {
  const result = classifyAvailability(undefined, 'tv', 2);
  assert.equal(result.status, 'pass');
  assert.equal(result.reasonCode, 'AVAILABLE_FOR_REQUEST');
});

// ── TV: no specific season ────────────────────────────────────────────────────

test('tv no season: show fully available (status 5) → ALREADY_AVAILABLE', () => {
  const result = classifyAvailability(makeMediaInfo({ status: 5 }), 'tv', null);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'ALREADY_AVAILABLE');
});

test('tv no season: show partially available (status 4) → ALREADY_AVAILABLE', () => {
  const result = classifyAvailability(makeMediaInfo({ status: 4 }), 'tv', null);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'ALREADY_AVAILABLE');
});

test('tv no season: show pending (status 2) → ALREADY_AVAILABLE', () => {
  const result = classifyAvailability(makeMediaInfo({ status: 2 }), 'tv', null);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'ALREADY_AVAILABLE');
});

test('tv no season: show-level request (no seasons on request) → ALREADY_REQUESTED', () => {
  const result = classifyAvailability(
    makeMediaInfo({ requests: [makeRequest(/* no seasons */)] }),
    'tv',
    null
  );
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'ALREADY_REQUESTED');
});

test('tv no season: all show seasons tracked → ALREADY_AVAILABLE', () => {
  const result = classifyAvailability(
    makeMediaInfo({
      seasons: [
        { id: 1, seasonNumber: 1, status: 5, createdAt: '', updatedAt: '' },
        { id: 2, seasonNumber: 2, status: 5, createdAt: '', updatedAt: '' },
      ],
    }),
    'tv',
    null,
    {
      showSeasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
    }
  );
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'ALREADY_AVAILABLE');
});

test('tv no season: all show seasons requested → ALREADY_REQUESTED', () => {
  const result = classifyAvailability(
    makeMediaInfo({ requests: [makeRequest([1, 2])] }),
    'tv',
    null,
    {
      showSeasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
    }
  );
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'ALREADY_REQUESTED');
});

test('tv no season: requestedSeasons all available → SEASON_AVAILABLE', () => {
  const result = classifyAvailability(
    makeMediaInfo({
      seasons: [
        { id: 1, seasonNumber: 1, status: 5, createdAt: '', updatedAt: '' },
        { id: 2, seasonNumber: 2, status: 5, createdAt: '', updatedAt: '' },
      ],
    }),
    'tv',
    null,
    {
      showSeasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 3 }],
      requestedSeasons: [1, 2],
    }
  );
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'SEASON_AVAILABLE');
});

test('tv no season: requestedSeasons all requested → SEASON_REQUESTED', () => {
  const result = classifyAvailability(
    makeMediaInfo({ requests: [makeRequest([1, 2])] }),
    'tv',
    null,
    {
      showSeasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 3 }],
      requestedSeasons: [1, 2],
    }
  );
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'SEASON_REQUESTED');
});

test('tv no season: requestedSeasons all covered (mix available+requested) → SEASON_REQUESTED', () => {
  const result = classifyAvailability(
    makeMediaInfo({
      seasons: [{ id: 1, seasonNumber: 1, status: 5, createdAt: '', updatedAt: '' }],
      requests: [makeRequest([2])],
    }),
    'tv',
    null,
    {
      showSeasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 3 }],
      requestedSeasons: [1, 2],
    }
  );
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'SEASON_REQUESTED');
});

test('tv no season: no mediaInfo → AVAILABLE_FOR_REQUEST', () => {
  const result = classifyAvailability(undefined, 'tv', null);
  assert.equal(result.status, 'pass');
  assert.equal(result.reasonCode, 'AVAILABLE_FOR_REQUEST');
});

test('tv no season: partial seasons, none of requestedSeasons covered → AVAILABLE_FOR_REQUEST', () => {
  const result = classifyAvailability(
    makeMediaInfo({
      seasons: [{ id: 1, seasonNumber: 1, status: 5, createdAt: '', updatedAt: '' }],
    }),
    'tv',
    null,
    {
      showSeasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 3 }],
      requestedSeasons: [2, 3],
    }
  );
  assert.equal(result.status, 'pass');
  assert.equal(result.reasonCode, 'AVAILABLE_FOR_REQUEST');
});

// ── reason string smoke tests ─────────────────────────────────────────────────

test('movie ALREADY_AVAILABLE reason includes status label', () => {
  const result = classifyAvailability(makeMediaInfo({ status: 3 }), 'movie', null);
  assert.ok(result.reason?.toLowerCase().includes('processing'), `expected "processing" in "${result.reason}"`);
});

test('tv + seasonNumber SEASON_AVAILABLE reason mentions season number', () => {
  const result = classifyAvailability(
    makeMediaInfo({ seasons: [{ id: 1, seasonNumber: 4, status: 5, createdAt: '', updatedAt: '' }] }),
    'tv',
    4
  );
  assert.ok(result.reason?.includes('4'), `expected "4" in "${result.reason}"`);
});
