import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Replays the reported MF GHOST metadata, including its inconsistent season count. */
function showDetails() {
  return {
    id: 154526,
    name: 'MF GHOST',
    numberOfSeasons: 1,
    numberOfEpisodes: 48,
    seasons: [0, 1, 2, 3, 4].map(seasonNumber => ({ seasonNumber, episodeCount: 12 })),
    mediaInfo: {
      id: 10,
      tmdbId: 154526,
      status: 4,
      seasons: [0, 1, 2, 3, 4].map(seasonNumber => ({
        seasonNumber,
        status: seasonNumber === 1 ? 5 : 7,
      })),
      requests: [0, 1].map((seasonNumber, index) => ({
        id: 483 + index,
        status: 2,
        seasons: [{ seasonNumber, status: 2 }],
        requestedBy: { id: 1, email: 'test@example.com' },
        createdAt: '2026-09-01',
      })),
    },
  };
}

/** Starts the real MCP server against an isolated mock API and closes both after the test. */
async function withTools(
  details: any,
  run: (call: (name: string, args: Record<string, unknown>) => Promise<any>, posts: any[]) => Promise<void>,
  options: { acceptedSeasons?: number[]; requestStatus?: number } = {},
) {
  const posts: any[] = [];
  const api = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url!, 'http://localhost');
    if (req.method === 'GET' && ['/api/v1/tv/154526', '/api/v1/movie/154526'].includes(url.pathname)) {
      res.end(JSON.stringify(details));
    } else if (req.method === 'GET' && url.pathname === '/api/v1/search') {
      const results = url.searchParams.get('query') === 'MF Ghost' ? [{
        id: details.id, name: details.name, mediaType: 'tv', overview: '',
      }] : [];
      res.end(JSON.stringify({ page: 1, totalPages: 1, totalResults: results.length, results }));
    } else if (req.method === 'POST' && req.url === '/api/v1/request') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      posts.push(request);
      res.statusCode = options.requestStatus ?? 200;
      res.end(JSON.stringify({
        id: 485,
        status: 2,
        seasons: (options.acceptedSeasons ?? request.seasons)?.map((seasonNumber: number) => ({ seasonNumber, status: 2 })),
      }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ message: `Unexpected API call: ${req.method} ${req.url}` }));
    }
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../../index.js', import.meta.url))],
    env: {
      SEERR_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
      SEERR_API_KEY: 'regression-test-key-local-only',
      HTTP_MODE: 'false',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'regression-tests', version: '1.0.0' });
  try {
    await client.connect(transport);
    await run(async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      assert.ok(!response.isError, JSON.stringify(response.content));
      const content = response.content as Array<{ type: string; text: string }>;
      return JSON.parse(content[0].text);
    }, posts);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  }
}

test('request_media: MF GHOST season 2 is requestable with requests for seasons 0 and 1', async () => {
  await withTools(showDetails(), async (call, posts) => {
    const result = await call('request_media', {
      mediaType: 'tv', mediaId: 154526, seasons: [2], confirmed: true, validateFirst: true,
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(result.seasonsRequested, [2]);
    assert.deepEqual(posts.map(post => post.seasons), [[2]]);
  });
});

test('request_media: an unrelated request alone must not block season 2', async () => {
  const details = showDetails();
  details.mediaInfo.status = 1;
  details.mediaInfo.seasons = [];
  details.mediaInfo.requests = [details.mediaInfo.requests[1]];
  await withTools(details, async (call, posts) => {
    const result = await call('request_media', {
      mediaType: 'tv', mediaId: 154526, seasons: [2], confirmed: true, validateFirst: true,
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(posts.map(post => post.seasons), [[2]]);
  });
});

test('request_media: show-level availability alone must not block season 2', async () => {
  const details = showDetails();
  details.mediaInfo.requests = [];
  await withTools(details, async (call, posts) => {
    const result = await call('request_media', {
      mediaType: 'tv', mediaId: 154526, seasons: [2], confirmed: true, validateFirst: true,
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(posts.map(post => post.seasons), [[2]]);
  });
});

test('request_media: validation defaults to true and blocks the requested available season', async () => {
  await withTools(showDetails(), async (call, posts) => {
    const result = await call('request_media', {
      mediaType: 'tv', mediaId: 154526, seasons: [1], confirmed: true,
    });
    assert.equal(result.status, 'SEASON_AVAILABLE', JSON.stringify(result));
    assert.equal(result.success, false);
    assert.equal(posts.length, 0);
  });
});

test('request_media: matching request seasons block and unrelated requests are omitted', async () => {
  await withTools(showDetails(), async (call, posts) => {
    const result = await call('request_media', {
      mediaType: 'tv', mediaId: 154526, seasons: [0], confirmed: true, validateFirst: true,
    });
    assert.equal(result.status, 'SEASON_REQUESTED', JSON.stringify(result));
    assert.deepEqual(result.existingRequests.map((request: any) => request.id), [483]);
    assert.deepEqual(result.existingRequests[0].seasons, [0]);
    assert.equal(posts.length, 0);
  });
});

test('request_media: mixed seasons submit only untracked seasons', async () => {
  await withTools(showDetails(), async (call, posts) => {
    const result = await call('request_media', {
      mediaType: 'tv', mediaId: 154526, seasons: [0, 1, 2], confirmed: true,
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(result.seasonsRequested, [2]);
    assert.deepEqual(result.skippedSeasons.map((season: any) => season.seasonNumber), [0, 1]);
    assert.deepEqual(posts.map(post => post.seasons), [[2]]);
  });
});

test('request_media: all uses the season array and excludes specials and tracked seasons', async () => {
  await withTools(showDetails(), async (call, posts) => {
    const result = await call('request_media', {
      mediaType: 'tv', mediaId: 154526, seasons: 'all', confirmed: true,
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(posts.map(post => post.seasons), [[2, 3, 4]]);
  });
});

test('request_media: batch and dry-run use the same season validation', async () => {
  await withTools(showDetails(), async (call, posts) => {
    const preview = await call('request_media', {
      mediaType: 'tv', mediaId: 154526, seasons: [1, 2], dryRun: true,
    });
    assert.deepEqual(preview.wouldRequest.seasons, [2]);
    assert.equal(posts.length, 0);
    const result = await call('request_media', {
      items: [{ mediaType: 'tv', mediaId: 154526, seasons: [1, 2] }], confirmed: true,
    });
    assert.deepEqual(result.results[0].seasonsRequested, [2]);
    assert.deepEqual(posts.map(post => post.seasons), [[2]]);
  });
});

test('request_media: validateFirst false bypasses season validation', async () => {
  await withTools(showDetails(), async (call, posts) => {
    const result = await call('request_media', {
      mediaType: 'tv', mediaId: 154526, seasons: [1], confirmed: true, validateFirst: false,
    });
    assert.equal(result.success, true);
    assert.deepEqual(posts.map(post => post.seasons), [[1]]);
  });
});

test('request_media: movie requests retain duplicate protection by default', async () => {
  await withTools(showDetails(), async (call, posts) => {
    const result = await call('request_media', { mediaType: 'movie', mediaId: 154526 });
    assert.equal(result.success, false);
    assert.equal(result.status, 'ALREADY_REQUESTED');
    assert.equal(posts.length, 0);
  });
});

test('request_media: confirmation counts only seasons that still need requesting', async () => {
  await withTools(showDetails(), async (call, posts) => {
    const confirmation = await call('request_media', {
      mediaType: 'tv', mediaId: 154526, seasons: 'all',
    });
    assert.equal(confirmation.requiresConfirmation, true);
    assert.deepEqual(confirmation.media.requestingSeasons, [2, 3, 4]);
    assert.equal(confirmation.media.requestingEpisodes, 36);
    assert.equal(posts.length, 0);
    const smallRequest = await call('request_media', {
      mediaType: 'tv', mediaId: 154526, seasons: [0, 1, 2, 3],
    });
    assert.equal(smallRequest.success, true, JSON.stringify(smallRequest));
    assert.deepEqual(posts.map(post => post.seasons), [[2, 3]]);
  });
});

test('request_media: standard-quality seasons and requests do not block a 4K request', async () => {
  await withTools(showDetails(), async (call, posts) => {
    const result = await call('request_media', {
      mediaType: 'tv', mediaId: 154526, seasons: [0, 1], is4k: true,
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(posts.map(post => ({ is4k: post.is4k, seasons: post.seasons })), [
      { is4k: true, seasons: [0, 1] },
    ]);
  });
});

test('request_media: completed and declined requests do not block deleted seasons', async () => {
  const details = showDetails();
  details.mediaInfo.requests[0].status = 5;
  details.mediaInfo.requests[1].status = 3;
  details.mediaInfo.seasons[1].status = 7;
  await withTools(details, async (call, posts) => {
    const result = await call('request_media', {
      mediaType: 'tv', mediaId: 154526, seasons: [0, 1], confirmed: true,
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(posts.map(post => post.seasons), [[0, 1]]);
  });
});

test('search_media: autoNormalize applies to single and batch searches', async () => {
  await withTools(showDetails(), async call => {
    const single = await call('search_media', { query: 'MF Ghost Season 2', autoNormalize: true });
    assert.equal(single.results[0]?.id, 154526);
    const batch = await call('search_media', { queries: ['MF Ghost Season 2'], autoNormalize: true });
    assert.equal(batch.results[0].results[0]?.id, 154526);
    const literal = await call('search_media', { query: 'MF Ghost Season 2' });
    assert.equal(literal.total, 0);
  });
});

test('search_media: includeDetails and checkAvailability work in compact single search', async () => {
  await withTools(showDetails(), async call => {
    const result = await call('search_media', {
      query: 'MF Ghost', checkAvailability: true, format: 'compact',
      includeDetails: { fields: ['mediaType', 'numberOfSeasons', 'numberOfEpisodes', 'seasons', 'mediaStatus'] },
    });
    const item = result.results[0];
    assert.equal(item.status, 'APPROVED');
    assert.equal(item.details.mediaType, 'tv');
    assert.equal(item.details.numberOfSeasons, 1);
    assert.equal(item.details.numberOfEpisodes, 48);
    assert.equal(item.details.mediaStatus, 4);
    assert.equal(item.details.seasons.find((season: any) => season.seasonNumber === 2).status, 'DELETED');
  });
});

test('search_media: dedupe reads request.seasons without a nested media object', async () => {
  await withTools(showDetails(), async call => {
    const result = await call('search_media', {
      dedupeMode: true, titles: ['MF Ghost Season 2'], autoNormalize: true,
      includeDetails: { fields: ['seasons'] },
    });
    assert.equal(result.summary.failed, 0, JSON.stringify(result));
    assert.equal(result.results[0].reasonCode, 'AVAILABLE_FOR_REQUEST');
    assert.equal(result.results[0].details.targetSeason.status, 'DELETED');
  });
});

test('search_media: batch and full formats retain requested fields and optional targetSeason', async () => {
  await withTools(showDetails(), async call => {
    const batch = await call('search_media', {
      queries: ['MF Ghost Season 2'], autoNormalize: true,
      includeDetails: { fields: ['seasons'] },
    });
    assert.equal(batch.results[0].query, 'MF Ghost Season 2');
    assert.equal(batch.results[0].results[0].details.targetSeason.seasonNumber, 2);
    const full = await call('search_media', {
      query: 'MF Ghost Season 2', autoNormalize: true, format: 'full',
      includeDetails: { fields: ['mediaStatus'], includeSeason: false },
    });
    assert.equal(full.results[0].mediaType, 'tv');
    assert.equal(full.results[0].details.mediaStatus, 4);
    assert.equal(full.results[0].details.targetSeason, undefined);
  });
});

test('search_media: checkAvailability alone fetches current media state', async () => {
  const details = showDetails();
  details.mediaInfo.status = 7;
  details.mediaInfo.requests = [];
  await withTools(details, async call => {
    const search = await call('search_media', { query: 'MF Ghost', checkAvailability: true });
    assert.equal(search.results[0].status, 'DELETED');
    const raw = await call('get_media_details', { mediaType: 'tv', mediaId: 154526, level: 'full' });
    assert.equal(raw.mediaInfo.status, 7);
  });
});

test('request_media: nonexistent seasons fail before preview, classification, or submission', async () => {
  await withTools(showDetails(), async (call, posts) => {
    for (const options of [{ dryRun: true }, { confirmed: true }, { validateFirst: false }]) {
      const result = await call('request_media', {
        mediaType: 'tv', mediaId: 154526, seasons: [1, 99], ...options,
      });
      assert.equal(result.status, 'SEASON_NOT_FOUND', JSON.stringify(result));
      assert.equal(result.success, false);
      assert.deepEqual(result.missingSeasons, [99]);
    }
    assert.equal(posts.length, 0);
  });
});

test('request_media: batch preserves preview, confirmation, and blocked-season payloads', async () => {
  const details = showDetails();
  details.seasons[2].episodeCount = 30;
  await withTools(details, async (call, posts) => {
    const preview = await call('request_media', {
      items: [{ mediaType: 'tv', mediaId: 154526, seasons: [1, 2] }], dryRun: true,
    });
    assert.equal(preview.summary.failed, 0, JSON.stringify(preview));
    assert.equal(preview.summary.previewed, 1);
    assert.deepEqual(preview.results[0].wouldRequest.seasons, [2]);
    assert.deepEqual(preview.results[0].skippedSeasons.map((season: any) => season.seasonNumber), [1]);

    const batch = await call('request_media', {
      items: [
        { mediaType: 'tv', mediaId: 154526, seasons: [1, 2] },
        { mediaType: 'tv', mediaId: 154526, seasons: [1] },
        { mediaType: 'tv', mediaId: 154526, seasons: [99] },
      ],
    });
    assert.equal(batch.summary.successful, 0);
    assert.equal(batch.summary.requiresConfirmation, 1);
    assert.equal(batch.summary.failed, 2);
    assert.equal(batch.results[0].requiresConfirmation, true);
    assert.deepEqual(batch.results[0].media.requestingSeasons, [2]);
    assert.equal(batch.results[0].media.requestingEpisodes, 30);
    assert.equal(batch.results[0].confirmWith.confirmed, true);
    assert.deepEqual(batch.results[0].skippedSeasons.map((season: any) => season.seasonNumber), [1]);
    assert.equal(batch.errors[0].status, 'SEASON_AVAILABLE');
    assert.equal(batch.errors[1].status, 'SEASON_NOT_FOUND');
    assert.deepEqual(batch.errors[1].missingSeasons, [99]);
    assert.equal(posts.length, 0);
    const confirmed = await call('request_media', batch.results[0].confirmWith);
    assert.equal(confirmed.success, true);
    assert.deepEqual(posts.map(post => post.seasons), [[2]]);
  });
});

test('search_media: dedupe all expands before classification and previews uncovered seasons', async () => {
  await withTools(showDetails(), async (call, posts) => {
    for (const requestOptions of [{ seasons: 'all', dryRun: true }, { dryRun: true }]) {
      const result = await call('search_media', {
        dedupeMode: true, titles: ['MF Ghost'], autoRequest: true, requestOptions,
      });
      assert.equal(result.results[0].reasonCode, 'AVAILABLE_FOR_REQUEST', JSON.stringify(result));
      assert.deepEqual(result.autoRequests.wouldRequest[0].seasons, [2, 3, 4]);
      assert.deepEqual(result.autoRequests.wouldRequest[0].skippedSeasons.map((s: any) => s.seasonNumber), [1]);
    }
    assert.equal(posts.length, 0);
  });
});

test('search_media: dedupe explicit nonexistent seasons are blocked before auto-request', async () => {
  await withTools(showDetails(), async (call, posts) => {
    const result = await call('search_media', {
      dedupeMode: true, titles: ['MF Ghost'], autoRequest: true, requestOptions: { seasons: [99] },
    });
    assert.equal(result.results[0].reasonCode, 'SEASON_NOT_FOUND', JSON.stringify(result));
    assert.equal(result.results[0].isActionable, false);
    assert.equal(result.autoRequests, undefined);
    assert.equal(posts.length, 0);
  });
});

test('search_media: auto-request shares filtering and episode confirmation with direct requests', async () => {
  const details = showDetails();
  details.seasons[2].episodeCount = 30;
  await withTools(details, async (call, posts) => {
    const args = {
      dedupeMode: true, titles: ['MF Ghost'], autoRequest: true,
      requestOptions: { seasons: [1, 2], serverId: 0, profileId: 0, rootFolder: '/test/tv' },
    };
    const preview = await call('search_media', { ...args, requestOptions: { ...args.requestOptions, dryRun: true } });
    assert.deepEqual(preview.autoRequests.wouldRequest[0].seasons, [2]);
    assert.equal(posts.length, 0);

    const result = await call('search_media', args);
    assert.equal(posts.length, 0, 'auto-request must wait for episode confirmation');
    assert.equal(result.autoRequests.successful, 0);
    assert.equal(result.autoRequests.failed, 0);
    assert.equal(result.autoRequests.requiresConfirmation, 1);
    assert.deepEqual(result.autoRequests.confirmations[0].media.requestingSeasons, [2]);
    assert.equal(result.autoRequests.confirmations[0].confirmWith.serverId, 0);

    const confirmed = await call('search_media', {
      ...args, requestOptions: { ...args.requestOptions, confirmed: true },
    });
    assert.equal(confirmed.autoRequests.successful, 1);
    assert.equal(confirmed.autoRequests.requests[0].status, 2);
    assert.deepEqual(confirmed.autoRequests.requests[0].seasons, [2]);
    assert.deepEqual(confirmed.autoRequests.requests[0].skippedSeasons.map((s: any) => s.seasonNumber), [1]);
    assert.deepEqual(posts, [{ mediaType: 'tv', mediaId: 154526, is4k: false, seasons: [2], serverId: 0, profileId: 0, rootFolder: '/test/tv' }]);
  });
});

test('search_media: auto-request reports only the seasons actually accepted upstream', async () => {
  await withTools(showDetails(), async (call, posts) => {
    const result = await call('search_media', {
      dedupeMode: true, titles: ['MF Ghost'], autoRequest: true, requestOptions: { seasons: [2, 3] },
    });
    assert.deepEqual(posts.map(post => post.seasons), [[2, 3]]);
    assert.deepEqual(result.autoRequests.requests[0].seasons, [2]);
    assert.deepEqual(result.autoRequests.requests[0].seasonsRequested, [2]);
  }, { acceptedSeasons: [2] });
});

test('search_media: request counts exclude inactive and mismatched-quality requests in every mode', async () => {
  const details: any = showDetails();
  const request = details.mediaInfo.requests[0];
  details.mediaInfo.requests = [
    { ...request, id: 1, status: 3 },
    { ...request, id: 2, status: 5 },
    { ...request, id: 3, status: 3, is4k: true },
    { ...request, id: 4, status: 5, is4k: true },
    { ...request, id: 5, status: 2, is4k: true },
  ];
  await withTools(details, async call => {
    const includeDetails = { fields: ['hasRequests', 'requestCount'] };
    const single = await call('search_media', { query: 'MF Ghost', includeDetails });
    const batch = await call('search_media', { queries: ['MF Ghost'], includeDetails });
    for (const item of [single.results[0], batch.results[0].results[0]]) {
      assert.equal(item.details.hasRequests, false);
      assert.equal(item.details.requestCount, 0);
    }
    for (const is4k of [false, true]) {
      const dedupe = await call('search_media', {
        dedupeMode: true, titles: ['MF Ghost'], requestOptions: { is4k }, includeDetails,
      });
      assert.equal(dedupe.results[0].details.hasRequests, is4k);
      assert.equal(dedupe.results[0].details.requestCount, is4k ? 1 : 0);
    }
  });
});

test('search_media: 4K verdict, season details, request counts, and franchise info agree', async () => {
  const details: any = showDetails();
  details.mediaInfo.status4k = 4;
  details.mediaInfo.seasons[1].status4k = 7;
  details.mediaInfo.seasons[2].status4k = 5;
  details.mediaInfo.requests.push({ ...details.mediaInfo.requests[0], id: 490, is4k: true, seasons: [{ seasonNumber: 3, status: 2 }] });
  await withTools(details, async call => {
    const result = await call('search_media', {
      dedupeMode: true, titles: ['MF Ghost Season 1', 'MF Ghost Season 2', 'MF Ghost Season 3', 'MF Ghost'],
      autoNormalize: true, requestOptions: { is4k: true, seasons: 'all' },
      includeDetails: { fields: ['seasons', 'mediaStatus', 'hasRequests', 'requestCount'] },
    });
    assert.equal(result.results[0].reasonCode, 'AVAILABLE_FOR_REQUEST');
    assert.equal(result.results[0].details.targetSeason.status, 'DELETED');
    assert.equal(result.results[1].reasonCode, 'SEASON_AVAILABLE');
    assert.equal(result.results[1].details.targetSeason.status, 'AVAILABLE');
    assert.equal(result.results[2].reasonCode, 'SEASON_REQUESTED');
    assert.equal(result.results[2].details.targetSeason.status, 'REQUESTED');
    assert.equal(result.results[3].details.requestCount, 1);
    assert.equal(result.results[3].details.mediaStatus, 4);
    assert.match(result.results[3].franchiseInfo, /1 in library \(S2\)/);
    assert.match(result.results[3].franchiseInfo, /1 requested \(S3\)/);
  });
});

test('request_media: batch inherits quality defaults and does not retry failed POSTs', async () => {
  await withTools(showDetails(), async (call, posts) => {
    const preview = await call('request_media', {
      items: [{ mediaType: 'tv', mediaId: 154526, seasons: [1] }], is4k: true, dryRun: true,
    });
    assert.equal(preview.summary.failed, 0, JSON.stringify(preview));
    assert.equal(preview.results[0].wouldRequest.is4k, true);
    const failed = await call('request_media', {
      items: [{ mediaType: 'tv', mediaId: 154526, seasons: [2] }],
    });
    assert.equal(failed.summary.failed, 1);
    assert.equal(posts.length, 1, 'a failed POST must not be replayed by the batch wrapper');
  }, { requestStatus: 500 });
});

test('season lookup: count fallback never overrides an explicit season list or invents specials', async () => {
  const details = showDetails();
  details.seasons = [];
  details.numberOfSeasons = 2;
  await withTools(details, async (call, posts) => {
    const preview = await call('request_media', { mediaType: 'tv', mediaId: 154526, seasons: 'all', dryRun: true });
    assert.deepEqual(preview.wouldRequest.seasons, [2]);
    for (const season of [0, 3]) {
      const missing = await call('request_media', { mediaType: 'tv', mediaId: 154526, seasons: [season], dryRun: true });
      assert.equal(missing.status, 'SEASON_NOT_FOUND');
    }
    const dedupe = await call('search_media', {
      dedupeMode: true, titles: ['MF Ghost'], autoRequest: true, requestOptions: { seasons: 'all', dryRun: true },
    });
    assert.deepEqual(dedupe.autoRequests.wouldRequest[0].seasons, [2]);
    assert.equal(posts.length, 0);
  });

  details.seasons = [{ seasonNumber: 0, episodeCount: 1 }];
  await withTools(details, async (call, posts) => {
    const missing = await call('request_media', { mediaType: 'tv', mediaId: 154526, seasons: [2], dryRun: true });
    assert.equal(missing.status, 'SEASON_NOT_FOUND');
    const dedupe = await call('search_media', {
      dedupeMode: true, titles: ['MF Ghost'], autoRequest: true, requestOptions: { seasons: 'all', dryRun: true },
    });
    assert.equal(dedupe.results[0].reasonCode, 'SEASON_NOT_FOUND');
    assert.equal(dedupe.autoRequests, undefined);
    assert.equal(posts.length, 0);
  });
});

test('search_media: auto-request requires confirmation for the season in the title', async () => {
  const details = showDetails();
  details.seasons[2].episodeCount = 30;
  await withTools(details, async (call, posts) => {
    const result = await call('search_media', {
      dedupeMode: true, titles: ['MF Ghost Season 2'], autoNormalize: true, autoRequest: true,
      requestOptions: { seasons: [3] },
    });
    assert.equal(result.autoRequests.requiresConfirmation, 1);
    assert.deepEqual(result.autoRequests.confirmations[0].media.requestingSeasons, [2]);
    const confirmed = await call('request_media', result.autoRequests.confirmations[0].confirmWith);
    assert.equal(confirmed.status, 'APPROVED');
    assert.deepEqual(posts.map(post => post.seasons), [[2]]);
  });
});
