import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAvailability } from '../availabilityClassifier.js';
import type { MediaInfo, MediaRequest } from '../../types.js';

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

function makeRequest(seasonNumbers?: number[]): MediaRequest {
  return {
    id: 99,
    status: 2,
    seasons: seasonNumbers?.map(n => ({ seasonNumber: n, status: 2 })),
    media: {
      id: 1,
      tmdbId: 100,
      status: 1,
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

test('tv no season: partially available show (status 4) + untracked requestedSeason → AVAILABLE_FOR_REQUEST', () => {
  // Regression: show-level isTracked(4) must not block when explicit requestedSeasons
  // are provided and the target season is not yet tracked.
  const result = classifyAvailability(
    makeMediaInfo({
      status: 4,
      seasons: [{ id: 1, seasonNumber: 1, status: 5, createdAt: '', updatedAt: '' }],
    }),
    'tv',
    null,
    {
      showSeasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
      requestedSeasons: [2],
    }
  );
  assert.equal(result.status, 'pass');
  assert.equal(result.reasonCode, 'AVAILABLE_FOR_REQUEST');
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

// ── no-showSeasons fallback ───────────────────────────────────────────────────

test('tv no season, no showSeasons, has season-scoped request → ALREADY_REQUESTED', () => {
  // When showSeasons is omitted the classifier falls back to checking requests directly.
  // A populated requests array (with season scope) should block as ALREADY_REQUESTED.
  const result = classifyAvailability(
    makeMediaInfo({ requests: [makeRequest([1])] }),
    'tv',
    null
    // options omitted — no showSeasons
  );
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'ALREADY_REQUESTED');
});

test('tv no season, no showSeasons, no requests → AVAILABLE_FOR_REQUEST', () => {
  const result = classifyAvailability(makeMediaInfo(), 'tv', null);
  assert.equal(result.status, 'pass');
  assert.equal(result.reasonCode, 'AVAILABLE_FOR_REQUEST');
});

test('explicit seasons ignore show-level requests with unknown scope and missing season metadata', () => {
  const result = classifyAvailability(
    makeMediaInfo({ status: 5, requests: [makeRequest()] }),
    'tv', null, { requestedSeasons: [2] }
  );
  assert.equal(result.reasonCode, 'AVAILABLE_FOR_REQUEST');
});

test('request scope comes from request.seasons, not the media season inventory', () => {
  const request = makeRequest([1]);
  request.media.seasons = [{ seasonNumber: 1, status: 5 }, { seasonNumber: 2, status: 7 }];
  const mediaInfo = makeMediaInfo({ requests: [request] });
  assert.equal(classifyAvailability(mediaInfo, 'tv', 1).reasonCode, 'SEASON_REQUESTED');
  assert.equal(classifyAvailability(mediaInfo, 'tv', 2).reasonCode, 'AVAILABLE_FOR_REQUEST');
});

test('all regular seasons being tracked does not block explicit specials', () => {
  const result = classifyAvailability(
    makeMediaInfo({ seasons: [{ id: 1, seasonNumber: 1, status: 5, createdAt: '', updatedAt: '' }] }),
    'tv', null, { requestedSeasons: [0], showSeasons: [{ seasonNumber: 1 }] }
  );
  assert.equal(result.reasonCode, 'AVAILABLE_FOR_REQUEST');
});

test('season validation respects media status and the separate request status lifecycle', () => {
  for (const status of [2, 3, 4, 5]) {
    const info = makeMediaInfo({ seasons: [{ id: 1, seasonNumber: 2, status, createdAt: '', updatedAt: '' }] });
    assert.equal(classifyAvailability(info, 'tv', 2).reasonCode, 'SEASON_AVAILABLE');
  }
  for (const status of [1, 2, 3, 4, 5]) {
    const request = { ...makeRequest([2]), status };
    const info = makeMediaInfo({
      requests: [request],
      seasons: [{ id: 1, seasonNumber: 2, status: 7, createdAt: '', updatedAt: '' }],
    });
    assert.equal(classifyAvailability(info, 'tv', 2).reasonCode,
      [3, 5].includes(status) ? 'AVAILABLE_FOR_REQUEST' : 'SEASON_REQUESTED');
  }
});

test('4K season validation uses status4k and requests for the same quality', () => {
  const info = makeMediaInfo({
    status: 5,
    status4k: 4,
    requests: [{ ...makeRequest([3]), is4k: true }],
    seasons: [
      { id: 1, seasonNumber: 1, status: 5, status4k: 1, createdAt: '', updatedAt: '' },
      { id: 2, seasonNumber: 2, status: 1, status4k: 5, createdAt: '', updatedAt: '' },
    ],
  });
  assert.equal(classifyAvailability(info, 'tv', 1, { is4k: true }).reasonCode, 'AVAILABLE_FOR_REQUEST');
  assert.equal(classifyAvailability(info, 'tv', 2, { is4k: true }).reasonCode, 'SEASON_AVAILABLE');
  assert.equal(classifyAvailability(info, 'tv', 2).reasonCode, 'AVAILABLE_FOR_REQUEST');
  assert.equal(classifyAvailability(info, 'tv', 3, { is4k: true }).reasonCode, 'SEASON_REQUESTED');
  assert.equal(classifyAvailability(info, 'tv', 3).reasonCode, 'AVAILABLE_FOR_REQUEST');
});
