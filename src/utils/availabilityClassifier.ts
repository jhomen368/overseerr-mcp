import type { MediaInfo, MediaRequestSummary, ReasonCode } from '../types.js';
import { isTracked, label, statusForQuality } from './mediaStatus.js';

export interface ClassifierResult {
  status: 'pass' | 'blocked';
  reasonCode: ReasonCode;
  reason?: string;
}

export interface ClassifierOptions {
  /** All regular seasons from TMDB (seasonNumber > 0). Used for "all seasons" checks on TV. */
  showSeasons?: Array<{ seasonNumber: number }>;
  /** Explicit seasons the caller wants to request. When provided, checked as a unit. */
  requestedSeasons?: number[];
  /** Check the 4K library and requests instead of standard quality. */
  is4k?: boolean;
}

/**
 * Pure availability classifier. No I/O, no cache, no network.
 *
 * Answers: "given what Seerr already knows about this media, should it be requested?"
 *
 * Scope is intentionally narrow — NOT_FOUND and SEASON_NOT_FOUND are lookup failures
 * that happen before MediaInfo exists. The orchestrator handles those paths before
 * calling this function. See docs/adr/0002-availability-classifier-narrow-scope.md.
 */
export function classifyAvailability(
  mediaInfo: MediaInfo | undefined,
  mediaType: 'movie' | 'tv',
  seasonNumber: number | null,
  options: ClassifierOptions = {}
): ClassifierResult {
  if (mediaInfo) {
    mediaInfo = {
      ...mediaInfo,
      status: statusForQuality(mediaInfo, options.is4k),
      seasons: mediaInfo.seasons?.map(season => ({
        ...season,
        status: statusForQuality(season, options.is4k),
      })),
      requests: mediaInfo.requests?.filter(request => isActiveRequest(request, options.is4k)),
    };
  }
  if (mediaType === 'movie') {
    return classifyMovie(mediaInfo);
  }
  return classifyTv(mediaInfo, seasonNumber, options);
}

// ── Movie ─────────────────────────────────────────────────────────────────────

function classifyMovie(mediaInfo: MediaInfo | undefined): ClassifierResult {
  if (!mediaInfo) {
    return pass();
  }

  if (isTracked(mediaInfo.status)) {
    return blocked('ALREADY_AVAILABLE', `Already in library (${label(mediaInfo.status).toLowerCase()})`);
  }

  if (mediaInfo.requests && mediaInfo.requests.length > 0) {
    return blocked('ALREADY_REQUESTED', 'Already requested');
  }

  return pass();
}

// ── TV ────────────────────────────────────────────────────────────────────────

function classifyTv(
  mediaInfo: MediaInfo | undefined,
  seasonNumber: number | null,
  options: ClassifierOptions
): ClassifierResult {
  if (!mediaInfo) {
    return pass();
  }

  // ── Specific season in title ──────────────────────────────────────────────
  if (seasonNumber !== null) {
    return classifyTvSeason(mediaInfo, seasonNumber);
  }

  // ── No specific season ────────────────────────────────────────────────────
  return classifyTvShow(mediaInfo, options);
}

function classifyTvSeason(mediaInfo: MediaInfo, seasonNumber: number): ClassifierResult {
  const seasonInfo = mediaInfo.seasons?.find(s => s.seasonNumber === seasonNumber);
  if (seasonInfo && isTracked(seasonInfo.status)) {
    return blocked(
      'SEASON_AVAILABLE',
      `Season ${seasonNumber} is ${label(seasonInfo.status).toLowerCase()}`
    );
  }

  const seasonRequested = mediaInfo.requests?.some(req =>
    req.seasons?.some(s => s.seasonNumber === seasonNumber)
  );
  if (seasonRequested) {
    return blocked('SEASON_REQUESTED', `Season ${seasonNumber} is already requested`);
  }

  return pass();
}

function classifyTvShow(mediaInfo: MediaInfo, options: ClassifierOptions): ClassifierResult {
  const { showSeasons, requestedSeasons } = options;

  // Explicit targets are authoritative, even when show metadata is missing or stale.
  if (requestedSeasons && requestedSeasons.length > 0) {
    const results = requestedSeasons.map(season => classifyTvSeason(mediaInfo, season));
    if (results.every(result => result.reasonCode === 'SEASON_AVAILABLE')) {
      return blocked('SEASON_AVAILABLE', `Requested season(s) already in library (${requestedSeasons.join(', ')})`);
    }
    if (results.every(result => result.status === 'blocked')) {
      return blocked('SEASON_REQUESTED', `Requested season(s) already in library or requested (${requestedSeasons.join(', ')})`);
    }
    return pass();
  }

  // Show-level status applies only when no explicit seasons are targeted.
  if (isTracked(mediaInfo.status)) {
    return blocked('ALREADY_AVAILABLE', 'Already in library (show-level)');
  }

  // Show-level request (request with no seasons attached)
  const hasShowLevelRequest = mediaInfo.requests?.some(
    req => !req.seasons || req.seasons.length === 0
  );
  if (hasShowLevelRequest) {
    return blocked('ALREADY_REQUESTED', 'Already requested (show-level)');
  }

  const regularSeasons = showSeasons?.filter(s => s.seasonNumber > 0) ?? [];

  if (regularSeasons.length > 0) {
    // Check all regular seasons when the caller has not supplied explicit targets.
    const isSeasonTracked = (sNum: number): boolean =>
      mediaInfo.seasons?.some(si => si.seasonNumber === sNum && isTracked(si.status)) ?? false;
    const isSeasonRequested = (sNum: number): boolean =>
      mediaInfo.requests?.some(req => req.seasons?.some(s => s.seasonNumber === sNum)) ?? false;

    // All seasons tracked
    const allSeasonsAvailable = regularSeasons.every(s => isSeasonTracked(s.seasonNumber));
    if (allSeasonsAvailable && mediaInfo.seasons && mediaInfo.seasons.length > 0) {
      const nums = trackedSeasonNumbers(mediaInfo).join(', ');
      return blocked('ALREADY_AVAILABLE', `All regular seasons already in library (${nums})`);
    }

    // All seasons requested
    const allSeasonsRequested = regularSeasons.every(s => isSeasonRequested(s.seasonNumber));
    if (allSeasonsRequested && mediaInfo.requests && mediaInfo.requests.length > 0) {
      const nums = regularSeasons.map(s => s.seasonNumber).sort((a, b) => a - b).join(', ');
      return blocked('ALREADY_REQUESTED', `All regular seasons already requested (${nums})`);
    }
  } else {
    // Fallback: no showSeasons data — check requests only (show-level status already
    // handled at the top of this function, so isTracked would be false here)
    if (mediaInfo.requests && mediaInfo.requests.length > 0) {
      return blocked('ALREADY_REQUESTED', 'Already requested');
    }
  }

  return pass();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Declined and completed requests do not reserve seasons in Seerr. */
export function isActiveRequest(request: MediaRequestSummary, is4k = false): boolean {
  return request.status !== 3 && request.status !== 5 && (request.is4k ?? false) === is4k;
}

function pass(): ClassifierResult {
  return { status: 'pass', reasonCode: 'AVAILABLE_FOR_REQUEST' };
}

function blocked(reasonCode: ReasonCode, reason: string): ClassifierResult {
  return { status: 'blocked', reasonCode, reason };
}

/** Lists tracked regular seasons for display at the requested quality. */
export function trackedSeasonNumbers(mediaInfo: MediaInfo, is4k = false): number[] {
  return (
    mediaInfo.seasons
      ?.filter(s => s.seasonNumber > 0 && isTracked(statusForQuality(s, is4k)))
      .map(s => s.seasonNumber)
      .sort((a, b) => a - b) ?? []
  );
}
