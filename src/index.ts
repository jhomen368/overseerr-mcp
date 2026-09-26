#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  isInitializeRequest,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import { SeerrApiClient } from './utils/seerrClient.js';
import { VERSION } from './version.js';
import { normalizeTitle, extractSeasonNumber, inferExpectedMediaType, selectBestMatch } from './utils/normalize.js';
import { batchWithRetry } from './utils/retry.js';
import { classifyAvailability, isActiveRequest, trackedSeasonNumbers } from './utils/availabilityClassifier.js';
import { label as mediaStatusLabel, statusForQuality } from './utils/mediaStatus.js';
import {
  SearchResult,
  SearchResultItem,
  MediaRequest,
  MediaDetails,
  SearchMediaArgs,
  RequestMediaArgs,
  ManageRequestsArgs,
  GetDetailsArgs,
  DedupeResult,
  ReasonCode,
  CompactMediaResult,
  MediaInfo,
  DedupeDetails,
  GetServicesArgs,
  GetServiceDetailsArgs,
} from './types.js';

// Field mapping for includeDetails feature
type FieldMapper = (item: { mediaType: string; id: number }, details: MediaDetails, is4k?: boolean) => any;

const FIELD_MAP: Record<string, FieldMapper> = {
  // Basic info (from search results, no API call needed)
  'mediaType': (item) => item.mediaType,
  'year': (item, details) => details.releaseDate?.substring(0, 4) || details.firstAirDate?.substring(0, 4),
  'posterPath': (item, details) => details.posterPath,

  // Standard details (from MediaDetails API)
  'rating': (item, details) => details.voteAverage,
  'overview': (item, details) => details.overview,
  'genres': (item, details) => details.genres,
  'runtime': (item, details) => details.runtime,

  // TV-specific
  'numberOfSeasons': (item, details) => details.numberOfSeasons,
  'numberOfEpisodes': (item, details) => details.numberOfEpisodes,
  'seasons': (item, details, is4k) => enrichSeasons(details, is4k),

  // Advanced details
  'releaseDate': (item, details) => details.releaseDate,
  'firstAirDate': (item, details) => details.firstAirDate,
  'originalTitle': (item, details) => (details as any).originalTitle,
  'originalName': (item, details) => (details as any).originalName,
  'popularity': (item, details) => (details as any).popularity,
  'backdropPath': (item, details) => (details as any).backdropPath,
  'homepage': (item, details) => (details as any).homepage,
  'status': (item, details) => (details as any).status,
  'tagline': (item, details) => (details as any).tagline,

  // Availability info (from mediaInfo)
  'mediaStatus': (item, details, is4k) => details.mediaInfo ? statusForQuality(details.mediaInfo, is4k) : undefined,
  'hasRequests': (item, details, is4k = false) => details.mediaInfo?.requests?.some(req => isActiveRequest(req, is4k)) ?? false,
  'requestCount': (item, details, is4k = false) => details.mediaInfo?.requests?.filter(req => isActiveRequest(req, is4k)).length || 0,
};

/**
 * Enriches seasons array with availability status
 */
function enrichSeasons(details: MediaDetails, is4k = false): DedupeDetails['seasons'] {
  if (!details.seasons || !Array.isArray(details.seasons)) {
    return undefined;
  }
  
  return details.seasons.map(season => {
    // Find status for this season from mediaInfo
    let status = 'NOT_REQUESTED';
    
    if (details.mediaInfo?.seasons) {
      const seasonInfo = details.mediaInfo.seasons.find(s => s.seasonNumber === season.seasonNumber);
      if (seasonInfo) {
        status = mediaStatusLabel(statusForQuality(seasonInfo, is4k));
      }
    }
    
    // Check if this season has been requested
    if (details.mediaInfo?.requests) {
      const hasRequest = details.mediaInfo.requests.some(req =>
        isActiveRequest(req, is4k) && req.seasons?.some(s => s.seasonNumber === season.seasonNumber)
      );
      if (hasRequest && ['NOT_REQUESTED', 'UNKNOWN', 'DELETED'].includes(status)) {
        status = 'REQUESTED';
      }
    }
    
    return {
      seasonNumber: season.seasonNumber,
      episodeCount: season.episodeCount,
      airDate: season.airDate,
      status
    };
  });
}

/** Expands regular seasons from metadata, using the count only when no season list is supplied. */
function regularSeasonNumbers(details: MediaDetails): number[] {
  if (details.seasons?.length) {
    return details.seasons.filter(season => season.seasonNumber > 0).map(season => season.seasonNumber);
  }
  return Array.from({ length: details.numberOfSeasons || 0 }, (_, index) => index + 1);
}

/** Checks season existence before availability classification; counts never imply specials. */
function doesSeasonExist(details: MediaDetails, seasonNumber: number): boolean {
  if (!Number.isInteger(seasonNumber) || seasonNumber < 0) return false;
  if (details.seasons?.length) {
    return details.seasons.some(season => season.seasonNumber === seasonNumber);
  }
  return seasonNumber > 0 && seasonNumber <= (details.numberOfSeasons || 0);
}

// Validation functions
function validateSeerrUrl(url: string): { valid: boolean; error?: string } {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'SEERR_URL must be a non-empty string' };
  }
  
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'SEERR_URL must use http:// or https:// protocol' };
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, error: 'SEERR_URL must be a valid URL (e.g., https://seerr.example.com or https://overseerr.example.com)' };
  }
}

function validateApiKey(key: string): { valid: boolean; error?: string } {
  if (!key || typeof key !== 'string') {
    return { valid: false, error: 'SEERR_API_KEY must be a non-empty string' };
  }
  
  // API keys should be at least 20 characters and Base64-compatible
  if (key.length < 20) {
    return { valid: false, error: 'SEERR_API_KEY appears to be too short (expected at least 20 characters)' };
  }
  
  if (!/^[a-zA-Z0-9\-_+/=]+$/.test(key)) {
    return { valid: false, error: 'SEERR_API_KEY contains invalid characters. It should be a Base64-compatible string.' };
  }
  
  return { valid: true };
}

// Environment variable aliasing: Support both Seerr and Overseerr naming
// SEERR_* variables take precedence for forward compatibility
const SEERR_URL = process.env.SEERR_URL || process.env.OVERSEERR_URL;
const SEERR_API_KEY = process.env.SEERR_API_KEY || process.env.OVERSEERR_API_KEY;

// Log deprecation warning for Overseerr variables (non-intrusive)
const isUsingLegacyUrl = process.env.OVERSEERR_URL && !process.env.SEERR_URL;
const isUsingLegacyApiKey = process.env.OVERSEERR_API_KEY && !process.env.SEERR_API_KEY;

if (isUsingLegacyUrl || isUsingLegacyApiKey) {
  console.error('[DEPRECATION WARNING] Legacy OVERSEERR_* variables are in use. Support will be removed in v3.0.0.');
  if (isUsingLegacyUrl) {
    console.error('  - Please migrate from OVERSEERR_URL to the preferred SEERR_URL.');
  }
  if (isUsingLegacyApiKey) {
    console.error('  - Please migrate from OVERSEERR_API_KEY to the preferred SEERR_API_KEY.');
  }
}

if (!SEERR_URL || !SEERR_API_KEY) {
  throw new Error(
    'SEERR_URL (or OVERSEERR_URL) and SEERR_API_KEY (or OVERSEERR_API_KEY) environment variables are required'
  );
}

// Validate URL format
const urlValidation = validateSeerrUrl(SEERR_URL);
if (!urlValidation.valid) {
  throw new Error(`Invalid SEERR_URL: ${urlValidation.error}`);
}

// Validate API key format
const keyValidation = validateApiKey(SEERR_API_KEY);
if (!keyValidation.valid) {
  throw new Error(`Invalid SEERR_API_KEY: ${keyValidation.error}`);
}

class OverseerrServer {
  private server: Server;
  private client: SeerrApiClient;

  constructor() {
    this.server = new Server(
      {
        name: 'seerr-mcp',
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.client = new SeerrApiClient(SEERR_URL!, SEERR_API_KEY!);
    this.setupToolHandlers();

    this.server.onerror = (error: Error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  /**
   * Enriches a search result with requested detail fields
   */
  private enrichSearchResult<T extends object>(
    baseResult: T,
    item: { mediaType: string; id: number },
    details: MediaDetails,
    requestedFields: string[],
    seasonNumber?: number | null,
    includeSeason: boolean = true,
    is4k: boolean = false
  ): T & { details?: DedupeDetails } {
    if (!requestedFields || requestedFields.length === 0) {
      return baseResult;
    }
    
    const enrichedDetails: DedupeDetails = {};
    
    // Extract requested fields using field mappers
    for (const field of requestedFields) {
      const mapper = FIELD_MAP[field];
      if (mapper) {
        const value = mapper(item, details, is4k);
        if (value !== undefined && value !== null) {
          (enrichedDetails as any)[field] = value;
        }
      }
    }
    
    // Auto-add targetSeason for TV shows with season number
    if (includeSeason && seasonNumber != null && item.mediaType === 'tv' && details.seasons) {
      const targetSeasonData = enrichSeasons(details, is4k)?.find(s => s.seasonNumber === seasonNumber);
      if (targetSeasonData) {
        enrichedDetails.targetSeason = {
          ...targetSeasonData,
          status: targetSeasonData.status || 'NOT_REQUESTED',
        };
      }
    }
    
    // Only add details object if it has at least one field
    if (Object.keys(enrichedDetails).length > 0) {
      return {
        ...baseResult,
        details: enrichedDetails,
      };
    }
    
    return baseResult;
  }

  private filterDetailsByLevel(
    details: MediaDetails,
    level: string,
    fields?: string[]
  ): any {
    // If specific fields requested, return only those
    if (fields && fields.length > 0) {
      const filtered: any = {};
      const item = { mediaType: details.mediaType || 'movie', id: details.id };
      fields.forEach(field => {
        const mapper = FIELD_MAP[field];
        if (mapper) {
          const value = mapper(item, details);
          if (value !== undefined) {
            filtered[field] = value;
          }
        }
      });
      return filtered;
    }

    // Level-based filtering
    switch (level) {
      case 'basic':
        return {
          id: details.id,
          mediaType: details.mediaType,
          title: details.title || details.name,
          overview: details.overview,
          year: details.releaseDate?.substring(0, 4) || details.firstAirDate?.substring(0, 4),
          rating: details.voteAverage,
          mediaInfo: details.mediaInfo ? {
            status: this.getMediaStatusString(details.mediaInfo.status),
            hasRequests: (details.mediaInfo.requests?.length || 0) > 0,
          } : undefined,
        };

      case 'standard':
        return {
          mediaType: details.mediaType,
          id: details.id,
          title: details.title || details.name,
          overview: details.overview,
          releaseDate: details.releaseDate || details.firstAirDate,
          genres: details.genres,
          voteAverage: details.voteAverage,
          runtime: details.runtime,
          numberOfSeasons: details.numberOfSeasons,
          numberOfEpisodes: details.numberOfEpisodes,
          seasons: details.seasons,
          mediaInfo: details.mediaInfo,
        };

      case 'full':
      default:
        return details;
    }
  }

  private setupToolHandlers(server?: Server) {
    const srv = server ?? this.server;
    srv.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'search_media',
          description:
            'Search movies/TV with single/batch/dedupe modes. Dedupe returns actionable status for batch processing.\n' +
            'Status: NOT_FOUND | ALREADY_AVAILABLE | ALREADY_REQUESTED | SEASON_AVAILABLE | SEASON_REQUESTED | AVAILABLE_FOR_REQUEST',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Single search query',
              },
              queries: {
                type: 'array',
                items: { type: 'string' },
                description: 'Multiple search queries (batch mode)',
              },
              dedupeMode: {
                type: 'boolean',
                description: 'Batch dedupe with availability check',
                default: false,
              },
              titles: {
                type: 'array',
                items: { type: 'string' },
                description: 'Titles to check (dedupe mode)',
              },
              autoNormalize: {
                type: 'boolean',
                description: 'Strip "Season N"/"Part N" from single, batch, and dedupe search titles',
                default: false,
              },
              autoRequest: {
                type: 'boolean',
                description: 'Auto-request passing items (requires dedupeMode). TV requests over 24 new episodes need requestOptions.confirmed:true.',
                default: false,
              },
              requestOptions: {
                type: 'object',
                description: 'AutoRequest options',
                properties: {
                  seasons: {
                    oneOf: [
                      { type: 'array', items: { type: 'number' } },
                      { type: 'string', enum: ['all'] },
                    ],
                    description: 'TV seasons. "all"=no season 0 (specials); [0,1,2]=with specials',
                  },
                  is4k: {
                    type: 'boolean',
                    description: 'Request 4K',
                    default: false,
                  },
                  serverId: { type: 'number' },
                  profileId: { type: 'number' },
                  rootFolder: { type: 'string' },
                  dryRun: {
                    type: 'boolean',
                    description: 'Preview only',
                    default: false,
                  },
                  confirmed: {
                    type: 'boolean',
                    description: 'Confirm TV requests over 24 new episodes',
                    default: false,
                  },
                },
              },
              checkAvailability: {
                type: 'boolean',
                description: 'Check status (slower, fetches per-result details)',
                default: false,
              },
              format: {
                type: 'string',
                enum: ['compact', 'standard', 'full'],
                description: 'Response format',
                default: 'compact',
              },
              limit: {
                type: 'number',
                description: 'Max results',
              },
              page: {
                type: 'number',
                description: 'Page number',
                default: 1,
              },
              language: {
                type: 'string',
                description: 'Language code',
                default: 'en',
              },
              includeDetails: {
                type: 'object',
                description: 'Add a details object to search results in any mode or format (fetches per-result details)',
                properties: {
                  fields: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 
                      'Basic: mediaType,year,posterPath | Standard: rating,overview,genres,runtime | ' +
                      'TV: numberOfSeasons,numberOfEpisodes,seasons | Advanced: releaseDate,firstAirDate,originalTitle,originalName,popularity,backdropPath,homepage,status,tagline | ' +
                      'Availability: mediaStatus,hasRequests,requestCount | targetSeason auto-adds for season numbers',
                  },
                  includeSeason: {
                    type: 'boolean',
                    description: 'Auto-add targetSeason for TV with season in title',
                    default: true,
                  },
                },
              },
            },
          },
        },
        {
          name: 'request_media',
          description:
            'Request media with auto-confirm for TV ≤24 eps. Single/batch with validation.\n' +
            'Confirm: Movies auto | TV ≤24 eps auto | TV >24 eps needs confirmed:true\n' +
            'TV needs seasons (array or "all"). "all"=no specials; [0,1,2]=with specials',
          inputSchema: {
            type: 'object',
            properties: {
              mediaType: {
                type: 'string',
                enum: ['movie', 'tv'],
                description: 'Media type (single)',
              },
              mediaId: {
                type: 'number',
                description: 'TMDB ID (single)',
              },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    mediaType: { type: 'string', enum: ['movie', 'tv'] },
                    mediaId: { type: 'number' },
                    seasons: {
                      oneOf: [
                        { type: 'array', items: { type: 'number' } },
                        { type: 'string', enum: ['all'] },
                      ],
                      description: 'TV seasons (REQUIRED). "all"=no season 0 (specials); [0,1,2]=with specials',
                    },
                    is4k: { type: 'boolean' },
                  },
                  required: ['mediaType', 'mediaId'],
                },
                description: 'Batch items',
              },
              seasons: {
                oneOf: [
                  { type: 'array', items: { type: 'number' } },
                  { type: 'string', enum: ['all'] },
                ],
                description: 'TV seasons. "all"=no season 0 (specials); [0,1,2]=with specials',
              },
              is4k: {
                type: 'boolean',
                description: 'Request 4K',
                default: false,
              },
              serverId: { type: 'number' },
              profileId: { type: 'number' },
              rootFolder: { type: 'string' },
              validateFirst: {
                type: 'boolean',
                description: 'Check existing requests and availability. TV checks only requested seasons and skips covered seasons.',
                default: true,
              },
              dryRun: {
                type: 'boolean',
                description: 'Preview only',
                default: false,
              },
              confirmed: {
                type: 'boolean',
                description: 'Confirm multi-season',
                default: false,
              },
            },
          },
        },
        {
          name: 'manage_media_requests',
          description:
            'Manage requests: get/list/approve/decline/delete. Supports filters and batching.\n' +
            'Filters: all|pending|approved|available|processing|unavailable|failed',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['get', 'list', 'approve', 'decline', 'delete'],
                description: 'Action',
              },
              requestId: {
                type: 'number',
                description: 'Request ID (single)',
              },
              requestIds: {
                type: 'array',
                items: { type: 'number' },
                description: 'Request IDs (batch)',
              },
              format: {
                type: 'string',
                enum: ['compact', 'standard', 'full'],
                default: 'compact',
              },
              summary: {
                type: 'boolean',
                description: 'Stats instead of list',
                default: false,
              },
              filter: {
                type: 'string',
                enum: ['all', 'pending', 'approved', 'available', 'processing', 'unavailable', 'failed'],
                default: 'all',
              },
              take: { type: 'number', default: 20 },
              skip: { type: 'number', default: 0 },
              sort: {
                type: 'string',
                enum: ['added', 'modified'],
                default: 'added',
              },
            },
            required: ['action'],
          },
        },
        {
          name: 'get_media_details',
          description:
            'Get media details. Single/batch with level control (basic/standard/full). ' +
            'Media/season status: 1=UNKNOWN, 2=PENDING, 3=PROCESSING, 4=PARTIALLY_AVAILABLE, 5=AVAILABLE, 7=DELETED (Seerr). ' +
            'Code 6 is BLOCKLISTED in Seerr or DELETED in legacy Overseerr. Request statuses use a separate enum.',
          inputSchema: {
            type: 'object',
            properties: {
              mediaType: {
                type: 'string',
                enum: ['movie', 'tv'],
                description: 'Media type (single)',
              },
              mediaId: {
                type: 'number',
                description: 'TMDB ID (single)',
              },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    mediaType: { type: 'string', enum: ['movie', 'tv'] },
                    mediaId: { type: 'number' },
                  },
                  required: ['mediaType', 'mediaId'],
                },
                description: 'Batch items',
              },
              level: {
                type: 'string',
                enum: ['basic', 'standard', 'full'],
                description: 'Detail level',
                default: 'standard',
              },
              fields: {
                type: 'array',
                items: { type: 'string' },
                description: 'Specific fields',
              },
              format: {
                type: 'string',
                enum: ['compact', 'standard', 'full'],
                default: 'compact',
              },
              language: {
                type: 'string',
                description: 'Language code',
                default: 'en',
              },
            },
          },
        },
        {
          name: 'get_services',
          description:
            'List configured Radarr/Sonarr servers. Returns ID, name, isDefault, 4K status, active defaults (directory, profile, tags).',
          inputSchema: {
            type: 'object',
            properties: {
              serviceType: {
                type: 'string',
                enum: ['radarr', 'sonarr'],
                description: 'Which service type to list. Omit for both.',
              },
            },
          },
        },
        {
          name: 'get_service_details',
          description:
            'Get quality profiles, root folders, tags, and language profiles (Sonarr) for a Radarr/Sonarr server.',
          inputSchema: {
            type: 'object',
            properties: {
              serviceType: {
                type: 'string',
                enum: ['radarr', 'sonarr'],
                description: 'Service type',
              },
              serverId: {
                type: 'number',
                description: 'Server ID from get_services (default: 0)',
                default: 0,
              },
            },
            required: ['serviceType'],
          },
        },
      ],
    }));

    srv.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      try {
        switch (request.params.name) {
          case 'search_media':
            return await this.handleSearchMedia(request.params.arguments);
          case 'request_media':
            return await this.handleRequestMedia(request.params.arguments);
          case 'manage_media_requests':
            return await this.handleManageRequests(request.params.arguments);
          case 'get_media_details':
            return await this.handleGetDetails(request.params.arguments);
          case 'get_services':
            return await this.handleGetServices(request.params.arguments);
          case 'get_service_details':
            return await this.handleGetServiceDetails(request.params.arguments);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const status = (error as any).response?.status;
          const message = (error as any).response?.data?.message || (error as any).message;
          return {
            content: [
              {
                type: 'text',
                text: `Seerr API error (${status}): ${message}`,
              },
            ],
            isError: true,
          };
        }
        throw error;
      }
    });
  }

  // Tool implementations will continue in the next section...
  // Due to character limits, I'll create a new file to continue
  private async handleSearchMedia(args: SearchMediaArgs) {
    const searchArgs = args as SearchMediaArgs;

    // Dedupe mode - batch check multiple titles
    if (searchArgs.dedupeMode && searchArgs.titles) {
      return this.handleDedupeMode(searchArgs);
    }

    // Batch mode - multiple queries
    if (searchArgs.queries && searchArgs.queries.length > 0) {
      return this.handleBatchSearch(searchArgs);
    }

    // Single search mode
    if (searchArgs.query) {
      return this.handleSingleSearch(searchArgs);
    }

    throw new McpError(
      ErrorCode.InvalidParams,
      'Must provide either query, queries, or (dedupeMode + titles)'
    );
  }

  private async handleSingleSearch(args: SearchMediaArgs) {
    const query = args.autoNormalize ? normalizeTitle(args.query!) : args.query!;
    const result = await this.client.search(query, {
      page: args.page || 1,
      language: args.language || 'en',
    });
    return this.formatSearchResponse(result, args);
  }

  private async handleBatchSearch(args: SearchMediaArgs) {
    const queries = args.queries!;
    
    const results = await batchWithRetry(
      queries,
      async (query) => {
        const searchTitle = args.autoNormalize ? normalizeTitle(query) : query;
        const result = await this.client.search(searchTitle, { page: args.page || 1, language: args.language || 'en' });
        return this.formatSearchResults(result, args, query);
      }
    );

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary: {
              total: queries.length,
              successful: successful.length,
              failed: failed.length,
            },
            results: successful.map(r => ({
              query: r.item,
              results: r.result,
            })),
            errors: failed.map(r => ({
              query: r.item,
              error: r.error?.message || 'Unknown error',
            })),
          }, null, 2),
        },
      ],
    };
  }

  private async handleDedupeMode(args: SearchMediaArgs) {
    const titles = args.titles!;
    const autoNormalize = args.autoNormalize || false;
    const autoRequest = args.autoRequest || false;
    const includeDetails = args.includeDetails;
    const requestedFields = includeDetails?.fields || [];
    const includeSeason = includeDetails?.includeSeason !== false;  // default true

    const dedupeResults: DedupeResult[] = [];
    const autoRequestQueue: Array<{ mediaType: 'movie' | 'tv'; mediaId: number; seasons?: number[] | 'all' }> = [];

    const processedTitles = await batchWithRetry(
      titles,
      async (originalTitle) => {
        const searchTitle = autoNormalize ? normalizeTitle(originalTitle) : originalTitle;
        const seasonNumber = extractSeasonNumber(originalTitle);

        // ── 1. Search ──────────────────────────────────────────────────────────
        const searchResult = await this.client.search(searchTitle, {
          page: 1,
          language: args.language || 'en',
        });

        if (!searchResult.results || searchResult.results.length === 0) {
          return {
            title: originalTitle,
            id: 0,
            mediaType: undefined,
            status: 'blocked' as const,
            reasonCode: 'NOT_FOUND' as ReasonCode,
            isActionable: false,
            note: 'Not found in TMDB',
          } satisfies DedupeResult;
        }

        // ── 2. Match ───────────────────────────────────────────────────────────
        const expectedType = inferExpectedMediaType(originalTitle);
        const selection = selectBestMatch(searchResult.results, expectedType, searchTitle);
        let bestMatch = selection.match;
        const alternates = selection.alternates;

        if (selection.confidence === 'low') {
          console.error(`[WARN] Low confidence match for "${originalTitle}": expected ${expectedType}, got ${bestMatch.mediaType} (${bestMatch.title || bestMatch.name})`);
        }

        // ── 3. Fetch details ───────────────────────────────────────────────────
        let details = await this.client.getMediaDetails(
          bestMatch.mediaType as 'movie' | 'tv',
          bestMatch.id
        );

        // ── 4. Season existence check (SEASON_NOT_FOUND — orchestrator concern) ─
        if (seasonNumber !== null && bestMatch.mediaType === 'tv') {
          if (!doesSeasonExist(details, seasonNumber)) {
            console.error(`[WARN] Season ${seasonNumber} not found in seasons data for "${bestMatch.title || bestMatch.name}". Trying alternates...`);
            let foundValid = false;
            const tvAlternates = alternates.filter(a => a.mediaType === 'tv').slice(0, 3);
            for (const alternate of tvAlternates) {
              const altDetails = await this.client.getMediaDetails('tv', alternate.id);
              if (doesSeasonExist(altDetails, seasonNumber)) {
                console.error(`[INFO] Found valid alternate: "${alternate.title || alternate.name}" for season ${seasonNumber}`);
                bestMatch = alternate;
                details = altDetails;
                foundValid = true;
                break;
              }
            }
            if (!foundValid) {
              const baseResult: DedupeResult = {
                title: originalTitle,
                id: bestMatch.id,
                mediaType: 'tv',
                status: 'blocked' as const,
                reason: `Season ${seasonNumber} not available - show exists but season does not`,
                reasonCode: 'SEASON_NOT_FOUND',
                isActionable: false,
                franchiseInfo: `Season ${seasonNumber} not found in "${bestMatch.title || bestMatch.name}"`,
              };
              return this.enrichSearchResult(baseResult, { mediaType: 'tv', id: bestMatch.id }, details, requestedFields, seasonNumber, includeSeason, args.requestOptions?.is4k);
            }
          }
        }

        // ── 5. Classify ────────────────────────────────────────────────────────
        const mediaType = bestMatch.mediaType as 'movie' | 'tv';
        const showSeasons = mediaType === 'tv'
          ? regularSeasonNumbers(details).map(seasonNumber => ({ seasonNumber }))
          : undefined;
        const seasonTarget = seasonNumber !== null ? [seasonNumber] : args.requestOptions?.seasons ?? (autoRequest ? 'all' : undefined);
        const requestedSeasons = mediaType === 'tv'
          ? seasonTarget === 'all' ? regularSeasonNumbers(details) : seasonTarget
          : undefined;

        if (requestedSeasons && (requestedSeasons.length === 0 || requestedSeasons.some(season => !doesSeasonExist(details, season)))) {
          const missingSeasons = requestedSeasons.filter(season => !doesSeasonExist(details, season));
          const baseResult: DedupeResult = {
            title: originalTitle,
            id: bestMatch.id,
            mediaType,
            status: 'blocked',
            reasonCode: 'SEASON_NOT_FOUND',
            isActionable: false,
            reason: missingSeasons.length > 0
              ? `Season(s) ${missingSeasons.join(', ')} not found in ${details.name || details.title}`
              : 'No regular seasons found to request',
          };
          return this.enrichSearchResult(baseResult, { mediaType, id: bestMatch.id }, details, requestedFields, seasonNumber, includeSeason, args.requestOptions?.is4k);
        }

        const classified = classifyAvailability(details.mediaInfo, mediaType, seasonNumber, {
          showSeasons,
          requestedSeasons,
          is4k: args.requestOptions?.is4k,
        });

        // ── 6. Build franchiseInfo (orchestrator assembles display string) ─────
        const showName = details.name || details.title || bestMatch.name || bestMatch.title || '';
        let franchiseInfo: string | undefined;

        if (mediaType === 'tv' && showName) {
          if (seasonNumber !== null) {
            franchiseInfo = `Season ${seasonNumber} of ${showName}`;
          } else {
            const availableNums = details.mediaInfo ? trackedSeasonNumbers(details.mediaInfo, args.requestOptions?.is4k) : [];
            const requestedNums = details.mediaInfo?.requests
              ?.filter(req => isActiveRequest(req, args.requestOptions?.is4k))
              .flatMap(req => req.seasons?.filter(s => s.seasonNumber > 0).map(s => s.seasonNumber) ?? [])
              .filter((n, i, arr) => arr.indexOf(n) === i)
              .sort((a, b) => a - b) ?? [];

            franchiseInfo = showName;
            const parts: string[] = [];
            if (availableNums.length > 0) parts.push(`${availableNums.length} in library (S${availableNums.join(', S')})`);
            if (requestedNums.length > 0) parts.push(`${requestedNums.length} requested (S${requestedNums.join(', S')})`);
            if (parts.length > 0) franchiseInfo += ` - ${parts.join(', ')}`;
          }
        }

        // ── 7. Build base result ───────────────────────────────────────────────
        const baseResult: DedupeResult = {
          title: originalTitle,
          id: bestMatch.id,
          mediaType,
          status: classified.status,
          reasonCode: classified.reasonCode,
          isActionable: classified.status === 'pass',
          ...(classified.reason !== undefined ? { reason: classified.reason } : {}),
          ...(franchiseInfo !== undefined ? { franchiseInfo } : {}),
        };

        // ── 8. Enrich (unconditional — no-op when requestedFields is empty) ────
        return this.enrichSearchResult(baseResult, { mediaType, id: bestMatch.id }, details, requestedFields, seasonNumber, includeSeason, args.requestOptions?.is4k);
      }
    );

    // Collect results
    processedTitles.forEach(result => {
      if (result.success && result.result) {
        const dedupeItem = result.result as DedupeResult;
        dedupeResults.push(dedupeItem);
        
        // If autoRequest enabled, queue this item for requesting
        if (autoRequest && dedupeItem.isActionable === true && dedupeItem.mediaType === 'tv') {
          const seasonNumber = extractSeasonNumber(result.item);
          
          // For TV shows, determine which seasons to request
          let seasonsToRequest: number[] | 'all' | undefined;
          if (seasonNumber !== null) {
            // Specific season mentioned in title
            seasonsToRequest = [seasonNumber];
          } else if (args.requestOptions?.seasons) {
            // Use requestOptions.seasons for TV shows without specific season
            seasonsToRequest = args.requestOptions.seasons;
          } else {
            // Default to 'all' if no season specified
            seasonsToRequest = 'all';
          }
          
          autoRequestQueue.push({
            mediaType: dedupeItem.mediaType,
            mediaId: dedupeItem.id,
            seasons: seasonsToRequest,
          });
        } else if (autoRequest && dedupeItem.isActionable === true && dedupeItem.mediaType === 'movie') {
          // Movies don't need seasons
          autoRequestQueue.push({
            mediaType: dedupeItem.mediaType,
            mediaId: dedupeItem.id,
          });
        }
      }
    });

    const passCount = dedupeResults.filter(r => r.status === 'pass').length;
    const blockedCount = dedupeResults.filter(r => r.status === 'blocked').length;
    const actionableCount = dedupeResults.filter(r => r.isActionable === true).length;

    // If autoRequest enabled and there are items to request, process them
    let autoRequestResults;
    if (autoRequest && autoRequestQueue.length > 0) {
      const batch = await this.executeRequestBatch({ ...args.requestOptions, items: autoRequestQueue }, 'code');
      const isDryRun = args.requestOptions?.dryRun === true;
      const errors = batch.errors.map(error => ({
        ...error,
        mediaType: error.item.mediaType,
        mediaId: error.item.mediaId,
      }));

      if (isDryRun) {
        autoRequestResults = {
          dryRun: true,
          totalQueued: autoRequestQueue.length,
          wouldRequest: batch.results.filter(result => result.dryRun).map(result => ({
            ...result.wouldRequest,
            ...(result.skippedSeasons ? { skippedSeasons: result.skippedSeasons } : {}),
          })),
          failed: batch.summary.failed,
          errors,
          message: 'Dry run - no requests were made. Remove "dryRun: true" from requestOptions to actually request.',
        };
      } else {
        autoRequestResults = {
          executed: batch.summary.successful > 0,
          totalRequested: autoRequestQueue.length,
          successful: batch.summary.successful,
          failed: batch.summary.failed,
          requiresConfirmation: batch.summary.requiresConfirmation,
          confirmations: batch.results.filter(result => result.requiresConfirmation),
          requests: batch.results.filter(result => result.success).map(result => ({
            ...result,
            seasons: result.seasonsRequested,
          })),
          errors,
        };
      }
    }

    const response: any = {
      summary: {
        total: titles.length,
        pass: passCount,
        blocked: blockedCount,
        failed: titles.length - dedupeResults.length,
        actionable: actionableCount,
        passRate: `${(titles.length > 0 ? (passCount / titles.length) * 100 : 0).toFixed(1)}%`,
      },
      results: dedupeResults,
    };

    if (autoRequestResults) {
      response.autoRequests = autoRequestResults;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }

  private async handleRequestMedia(args: any) {
    const requestArgs = args as RequestMediaArgs;

    // Batch mode
    if (requestArgs.items && requestArgs.items.length > 0) {
      return this.handleBatchRequest(requestArgs);
    }

    // Single mode
    if (!requestArgs.mediaType || !requestArgs.mediaId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Must provide mediaType and mediaId (or items array for batch)'
      );
    }

    return this.handleSingleRequest(requestArgs);
  }

  private async handleSingleRequest(args: RequestMediaArgs, statusFormat: 'label' | 'code' = 'label') {
    const { mediaType, mediaId, seasons, is4k, validateFirst = true, dryRun, confirmed } = args;
    const skippedSeasons: Array<{ seasonNumber: number; reasonCode: ReasonCode; reason?: string }> = [];

    // Validate TV show requests have seasons specified
    if (mediaType === 'tv' && !seasons) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'seasons parameter is required for TV show requests. Use seasons: [1,2,3] for specific seasons or seasons: "all" for all seasons.'
      );
    }

    const details = await this.client.getMediaDetails(mediaType as 'movie' | 'tv', mediaId!);

    // Expand "all" to actual season numbers (excluding season 0) early in the function
    let expandedSeasons: number[] | undefined = undefined;
    if (mediaType === 'tv' && seasons) {
      if (seasons === 'all') {
        expandedSeasons = regularSeasonNumbers(details);
      } else if (Array.isArray(seasons)) {
        // Already an array, use as-is
        expandedSeasons = seasons;
      } else {
        // seasons might be a string representation of an array or some other unexpected type
        // TypeScript narrows to never here, but at runtime MCP clients may pass unexpected types
        const seasonsAny = seasons as any;
        
        if (typeof seasonsAny === 'string' && seasonsAny.startsWith('[') && seasonsAny.endsWith(']')) {
          // Handle case where seasons is passed as a string representation of an array
          try {
            const parsed = JSON.parse(seasonsAny);
            if (Array.isArray(parsed)) {
              expandedSeasons = parsed;
            } else {
              expandedSeasons = [];
            }
          } catch (e) {
            expandedSeasons = [];
          }
        } else {
          expandedSeasons = [];
        }
      }
    }

    if (mediaType === 'tv' && (!expandedSeasons || expandedSeasons.length === 0)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'No valid seasons specified. Use seasons: [1, 2, 3] for specific seasons or seasons: "all" for all seasons.'
      );
    }

    if (mediaType === 'tv') {
      const missingSeasons = [...new Set(expandedSeasons)].filter(season => !doesSeasonExist(details, season));
      if (missingSeasons.length > 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              status: 'SEASON_NOT_FOUND',
              missingSeasons,
              message: `Season(s) ${missingSeasons.join(', ')} not found in ${details.name || details.title}`,
            }, null, 2),
          }],
        };
      }
    }

    // Validate first if requested
    if (validateFirst) {
      const mediaInfo = details.mediaInfo;
      const existingRequests = mediaInfo?.requests?.filter(request =>
        isActiveRequest(request, is4k) &&
        (mediaType !== 'tv' || request.seasons?.some(season => expandedSeasons!.includes(season.seasonNumber)))
      ) || [];

      if (mediaType === 'tv') {
        const classified = classifyAvailability(mediaInfo, 'tv', null, { requestedSeasons: expandedSeasons, is4k });
        const remainingSeasons: number[] = [];
        for (const seasonNumber of new Set(expandedSeasons)) {
          const season = classifyAvailability(mediaInfo, 'tv', seasonNumber, { is4k });
          if (season.status === 'blocked') {
            skippedSeasons.push({ seasonNumber, reasonCode: season.reasonCode, reason: season.reason });
          } else {
            remainingSeasons.push(seasonNumber);
          }
        }

        if (classified.status === 'blocked') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                status: classified.reasonCode,
                message: `${details.title || details.name}: ${classified.reason}`,
                skippedSeasons,
                existingRequests: existingRequests.map(request => ({
                  id: request.id,
                  status: this.getStatusString(request.status),
                  seasons: request.seasons?.map(season => season.seasonNumber),
                  requestedBy: request.requestedBy.displayName || request.requestedBy.email,
                  createdAt: request.createdAt,
                })),
              }, null, 2),
            }],
          };
        }
        expandedSeasons = remainingSeasons;
      } else if (existingRequests.length > 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                status: 'ALREADY_REQUESTED',
                message: `${details.title || details.name} is already requested`,
                existingRequests: existingRequests.map(r => ({
                  id: r.id,
                  status: this.getStatusString(r.status),
                  requestedBy: r.requestedBy.displayName || r.requestedBy.email,
                  createdAt: r.createdAt,
                })),
              }, null, 2),
            },
          ],
        };
      }

      const mediaStatus = mediaInfo ? statusForQuality(mediaInfo, is4k) : undefined;
      if (mediaType !== 'tv' && mediaStatus != null && [2, 3, 4, 5].includes(mediaStatus)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                status: 'ALREADY_AVAILABLE',
                message: `${details.title || details.name} is already available`,
              }, null, 2),
            },
          ],
        };
      }
    }

    // Multi-season confirmation check (skipped for dry runs — no actual request is made)
    if (mediaType === 'tv' && !confirmed && !dryRun && expandedSeasons) {
      const requireConfirm = process.env.REQUIRE_MULTI_SEASON_CONFIRM !== 'false';
      
      if (requireConfirm) {
        const totalSeasons = regularSeasonNumbers(details).length;
        const seasonsToRequest = expandedSeasons;

        // Calculate total episode count for requested seasons
        let totalEpisodes = 0;
        if (details.seasons) {
          seasonsToRequest.forEach((seasonNum: number) => {
            const seasonData = details.seasons?.find(s => s.seasonNumber === seasonNum);
            if (seasonData) {
              totalEpisodes += seasonData.episodeCount;
            }
          });
        }

        // Only require confirmation if episode count exceeds threshold (24)
        const EPISODE_THRESHOLD = 24;
        if (totalEpisodes > EPISODE_THRESHOLD) {
          // Build message including episode count for context
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  requiresConfirmation: true,
                  ...(skippedSeasons.length > 0 ? { skippedSeasons } : {}),
                  media: {
                    totalSeasons,
                    totalEpisodes: details.numberOfEpisodes,
                    requestingSeasons: seasonsToRequest,
                    requestingEpisodes: totalEpisodes,
                    threshold: EPISODE_THRESHOLD,
                  },
                  message: `This will request ${seasonsToRequest.length} season(s) with ${totalEpisodes} episodes of ${details.name}. Add "confirmed: true" to proceed.`,
                  confirmWith: {
                    ...args,
                    confirmed: true,
                  },
                }, null, 2),
              },
            ],
          };
        }
      }
    }

    let mediaTitle: string;
    mediaTitle = details.title ?? details.name ?? 'Unknown Media';

    // Dry run - don't actually request
    if (dryRun) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              dryRun: true,
              ...(skippedSeasons.length > 0 ? { skippedSeasons } : {}),
              wouldRequest: {
                title: mediaTitle,
                mediaType,
                mediaId,
                seasons: mediaType === 'tv' ? expandedSeasons : undefined,
                is4k: is4k || false,
              },
              message: 'Dry run - no request was made. Remove "dryRun: true" to actually request.',
            }, null, 2),
          },
        ],
      };
    }

    // Actually make the request
    const requestBody: any = {
      mediaType,
      mediaId,
      is4k: is4k || false,
    };

    // Specials are included only when explicitly requested, never by "all".
    if (mediaType === 'tv' && expandedSeasons) {
      requestBody.seasons = expandedSeasons;
    }

    if (args.serverId !== undefined) requestBody.serverId = args.serverId;
    if (args.profileId !== undefined) requestBody.profileId = args.profileId;
    if (args.rootFolder) requestBody.rootFolder = args.rootFolder;

    const createdRequest = await this.client.createRequest(requestBody);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            requestId: createdRequest.id,
            status: statusFormat === 'code' ? createdRequest.status : this.getStatusString(createdRequest.status),
            message: `Successfully requested ${mediaTitle}`,
            seasonsRequested: createdRequest.seasons?.map((s: any) => s.seasonNumber),
            ...(skippedSeasons.length > 0 ? { skippedSeasons } : {}),
          }, null, 2),
        },
      ],
    };
  }

  /** Shares validation and outcomes; auto-request keeps its numeric status format, and POSTs are never retried. */
  private async executeRequestBatch(args: RequestMediaArgs, statusFormat: 'label' | 'code' = 'label') {
    const items = args.items!;

    const results = await batchWithRetry(
      items,
      async (item) => {
        const singleArgs = {
          ...args,
          mediaType: item.mediaType,
          mediaId: item.mediaId,
          seasons: item.seasons,
          is4k: item.is4k ?? args.is4k,
          items: undefined,
        };
        
        const result = await this.handleSingleRequest(singleArgs, statusFormat);
        return JSON.parse(result.content[0].text);
      },
      // GETs retry inside the API client; retrying the whole operation could replay a POST.
      { maxAttempts: 1 }
    );

    const successful = results.filter(r => r.success && r.result?.success);
    const previews = results.filter(r => r.success && r.result?.dryRun);
    const confirmations = results.filter(r => r.success && r.result?.requiresConfirmation);
    const completed = results.filter(r => r.success && (r.result?.success || r.result?.dryRun || r.result?.requiresConfirmation));
    const failed = results.filter(r => !r.success || r.result?.success === false);

    return {
      summary: {
        total: items.length,
        successful: successful.length,
        previewed: previews.length,
        requiresConfirmation: confirmations.length,
        failed: failed.length,
      },
      results: completed.map(r => ({ ...r.result, mediaType: r.item.mediaType, mediaId: r.item.mediaId })),
      errors: failed.map(r => ({
        ...r.result,
        item: r.item,
        error: r.error?.response?.data?.message || r.error?.message || r.result?.message || 'Unknown error',
      })),
    };
  }

  /** Formats all batch outcomes, including previews, confirmation prompts, and blocked seasons. */
  private async handleBatchRequest(args: RequestMediaArgs) {
    const response = await this.executeRequestBatch(args);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }

  private async handleManageRequests(args: any) {
    const manageArgs = args as ManageRequestsArgs;

    switch (manageArgs.action) {
      case 'get':
        return this.handleGetRequest(manageArgs);
      case 'list':
        return this.handleListRequests(manageArgs);
      case 'approve':
        return this.handleApproveRequests(manageArgs);
      case 'decline':
        return this.handleDeclineRequests(manageArgs);
      case 'delete':
        return this.handleDeleteRequests(manageArgs);
      default:
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown action: ${manageArgs.action}`
        );
    }
  }

  private async handleGetRequest(args: ManageRequestsArgs) {
    if (!args.requestId) {
      throw new McpError(ErrorCode.InvalidParams, 'requestId is required for get action');
    }

    const request = await this.client.getRequest(args.requestId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(
          args.format === 'full' ? request : this.formatCompactRequest(request),
          null, 2
        ),
      }],
    };
  }

  private async handleListRequests(args: ManageRequestsArgs) {
    const { filter, take, skip, sort, summary } = args;

    if (summary) {
      const data = await this.client.listAllRequests({ filter, sort });
      const statusCounts: Record<string, number> = {};
      data.results.forEach((r: MediaRequest) => {
        const status = this.getStatusString(r.status);
        statusCounts[status] = (statusCounts[status] || 0) + 1;
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            total: data.results.length,
            statusBreakdown: statusCounts,
            filter: filter || 'all',
          }, null, 2),
        }],
      };
    }

    const requests = await this.client.listRequests({ filter, take, skip, sort });
    const formatted = requests.results.map(r =>
      args.format === 'full' ? r : this.formatCompactRequest(r)
    );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: formatted,
          pageInfo: requests.pageInfo,
        }, null, 2),
      }],
    };
  }

  private async handleApproveRequests(args: ManageRequestsArgs) {
    const ids = args.requestIds || (args.requestId ? [args.requestId] : []);
    if (ids.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'requestId or requestIds required for approve');
    }

    const results = await batchWithRetry(ids, async (id) => {
      await this.client.approveRequest(id);
      return { id, status: 'APPROVED' };
    });

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          summary: { total: ids.length, approved: successful.length, failed: failed.length },
          results: successful.map(r => r.result),
          errors: failed.map(r => ({ id: r.item, error: r.error?.message })),
        }, null, 2),
      }],
    };
  }

  private async handleDeclineRequests(args: ManageRequestsArgs) {
    const ids = args.requestIds || (args.requestId ? [args.requestId] : []);
    if (ids.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'requestId or requestIds required for decline');
    }

    const results = await batchWithRetry(ids, async (id) => {
      await this.client.declineRequest(id);
      return { id, status: 'DECLINED' };
    });

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          summary: { total: ids.length, declined: successful.length, failed: failed.length },
          results: successful.map(r => r.result),
          errors: failed.map(r => ({ id: r.item, error: r.error?.message })),
        }, null, 2),
      }],
    };
  }

  private async handleDeleteRequests(args: ManageRequestsArgs) {
    const ids = args.requestIds || (args.requestId ? [args.requestId] : []);
    if (ids.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'requestId or requestIds required for delete');
    }

    const results = await batchWithRetry(ids, async (id) => {
      await this.client.deleteRequest(id);
      return { id, deleted: true };
    });

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          summary: { total: ids.length, deleted: successful.length, failed: failed.length },
          results: successful.map(r => r.result),
          errors: failed.map(r => ({ id: r.item, error: r.error?.message })),
        }, null, 2),
      }],
    };
  }

  private async handleGetDetails(args: GetDetailsArgs) {
    const detailsArgs = args as GetDetailsArgs;

    // Batch mode
    if (detailsArgs.items && detailsArgs.items.length > 0) {
      return this.handleBatchDetails(detailsArgs);
    }

    // Single mode
    if (!detailsArgs.mediaType || !detailsArgs.mediaId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Must provide mediaType and mediaId (or items array for batch)'
      );
    }

    return this.handleSingleDetails(detailsArgs);
  }

  private async handleSingleDetails(args: GetDetailsArgs) {
    const { mediaType, mediaId, level, fields, language } = args;

    const details = await this.client.getMediaDetails(
      mediaType!,
      mediaId!,
      { language }
    );
    details.mediaType = mediaType!;

    const filtered = this.filterDetailsByLevel(details, level || 'standard', fields);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(filtered, null, 2),
        },
      ],
    };
  }

  private async handleBatchDetails(args: GetDetailsArgs) {
    const items = args.items!;

    const results = await batchWithRetry(
      items,
      async (item) => {
        const details = await this.client.getMediaDetails(
          item.mediaType,
          item.mediaId,
          { language: args.language }
        );
        details.mediaType = item.mediaType;
        return this.filterDetailsByLevel(details, args.level || 'standard', args.fields);
      }
    );

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary: {
              total: items.length,
              successful: successful.length,
              failed: failed.length
            },
            results: successful.map(r => r.result),
            errors: failed.map(r => ({
              item: r.item,
              error: r.error?.message || 'Unknown error'
            }))
          }, null, 2),
        }
      ]
    };
  }

  private async handleGetServices(args: GetServicesArgs) {
    let requestedServiceTypes: Array<'radarr' | 'sonarr'> = ['radarr', 'sonarr'];
    if (args.serviceType) {
      requestedServiceTypes = [args.serviceType];
    }

    const servicesResult = await Promise.all(
      requestedServiceTypes.map(async (serviceType) => {
        const services = await this.client.listServices(serviceType);
        return services.map(service => ({ serviceType, ...service }));
      })
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(servicesResult.flat(), null, 2),
        },
      ],
    };
  }

  private async handleGetServiceDetails(args: GetServiceDetailsArgs) {
    if (!args.serviceType) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'serviceType is required (radarr or sonarr)'
      );
    }

    const profileData = await this.client.getServiceDetails(
      args.serviceType,
      args.serverId ?? 0
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            server: profileData.server,
            profiles: profileData.profiles,
            rootFolders: profileData.rootFolders,
            tags: profileData.tags,
            ...(profileData.languageProfiles ? { languageProfiles: profileData.languageProfiles } : {}),
          }, null, 2),
        },
      ],
    };
  }

  /** Limits search hits before fetching optional per-result availability and detail fields. */
  private async formatSearchResults(result: SearchResult, args: SearchMediaArgs, query: string) {
    const limitedResults: SearchResultItem[] = this.limitResults(result.results, args.limit);
    return Promise.all(limitedResults.map(async item => {
      const fields = args.includeDetails?.fields || [];
      const isMedia = item.mediaType === 'movie' || item.mediaType === 'tv';
      const details = isMedia && (args.checkAvailability || fields.length > 0)
        ? await this.client.getMediaDetails(item.mediaType as 'movie' | 'tv', item.id, { language: args.language })
        : undefined;
      const enrichedItem = details ? { ...item, mediaInfo: details.mediaInfo } : item;
      const formatted = (args.format || 'compact') === 'compact'
        ? this.formatCompactResult(enrichedItem)
        : enrichedItem;
      return details
        ? this.enrichSearchResult(formatted, item, details, fields, extractSeasonNumber(query), args.includeDetails?.includeSeason !== false)
        : formatted;
    }));
  }

  private async formatSearchResponse(result: SearchResult, args: SearchMediaArgs) {
    const formattedResults = await this.formatSearchResults(result, args, args.query!);

    if ((args.format || 'compact') === 'compact') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              total: result.totalResults,
              results: formattedResults,
            }, null, 2),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...result,
            results: formattedResults,
          }, null, 2),
        },
      ],
    };
  }

  private formatCompactRequest(request: MediaRequest): any {
    return {
      id: request.id,
      status: this.getStatusString(request.status),
      mediaStatus: this.getMediaStatusString(request.media.status),
      tmdbId: request.media.tmdbId,
      requestedBy: request.requestedBy.displayName || request.requestedBy.email,
      createdAt: request.createdAt,
      seasons: request.seasons?.map(s => ({
        number: s.seasonNumber,
        status: this.getStatusString(s.status),
      })),
    };
  }

  private limitResults(results: any[], limit?: number): any[] {
    return limit ? results.slice(0, limit) : results;
  }

  private formatCompactResult(item: SearchResultItem, mediaInfo?: MediaInfo): CompactMediaResult {
    let status = 'NOT_REQUESTED';
    
    // Use explicitly passed mediaInfo, or fall back to mediaInfo embedded in the search result item
    const info = mediaInfo || item.mediaInfo;
    if (info) {
      // Use the shared media status labels, including Seerr's DELETED status.
      if (info.status && info.status !== 1) {
        status = this.getMediaStatusString(info.status);
      }
      // Request status takes precedence when present (e.g. APPROVED, PENDING_APPROVAL)
      if (info.requests && info.requests.length > 0) {
        const latestRequest = info.requests[0];
        status = this.getStatusString(latestRequest.status);
      }
    }
    
    return {
      id: item.id,
      type: item.mediaType,
      title: item.title || item.name || 'Unknown',
      year: item.releaseDate?.substring(0, 4) || item.firstAirDate?.substring(0, 4),
      rating: item.voteAverage,
      status: status,
    };
  }

  private getStatusString(status: number): string {
    const statusMap: { [key: number]: string } = {
      1: 'PENDING_APPROVAL',
      2: 'APPROVED',
      3: 'DECLINED',
      4: 'PENDING',
      5: 'AVAILABLE',
      6: 'DELETED',
    };
    return statusMap[status] || 'UNKNOWN';
  }

  private getMediaStatusString(status: number): string {
    return mediaStatusLabel(status);
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`Seerr MCP server v${VERSION} running on stdio`);
    console.error(`Supports both Seerr and Overseerr (legacy) instances`);
  }

  async runHttp(port: number = 8085) {
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const express = (await import('express')).default;

    const app = express();
    app.use(express.json({ limit: '4mb' }));

    const sessions = new Map<string, {
      transport: InstanceType<typeof StreamableHTTPServerTransport>;
      server: Server;
      lastUsed: number;
    }>();

    const STALE_TIMEOUT = 30 * 60 * 1000;
    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of sessions) {
        if (now - session.lastUsed > STALE_TIMEOUT) {
          session.server.close().catch(() => {});
          sessions.delete(id);
        }
      }
    }, 5 * 60 * 1000);
    cleanupInterval.unref();

    app.get('/health', (_req: any, res: any) => {
      res.json({
        status: 'ok',
        service: 'seerr-mcp',
        transport: 'streamable-http',
        compatibility: ['seerr', 'overseerr', 'jellyseerr'],
        version: VERSION,
      });
    });

    app.get('/cache/stats', (_req: any, res: any) => {
      res.json(this.client.getCacheStats());
    });

    const MAX_SESSIONS = 100;

    app.post('/mcp', async (req: any, res: any) => {
      const raw = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(raw) ? raw[0] : raw as string | undefined;

      try {
        // Existing session — forward request to its transport
        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          session.lastUsed = Date.now();
          await session.transport.handleRequest(req, res, req.body);
          return;
        }

        // New session — must be an initialize request
        if (!sessionId && isInitializeRequest(req.body)) {
          if (sessions.size >= MAX_SESSIONS) {
            res.status(503).json({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Server at session capacity, try again later',
              },
              id: null,
            });
            return;
          }
          const server = new Server(
            { name: 'seerr-mcp', version: VERSION },
            { capabilities: { tools: {} } },
          );

          server.onerror = (error: Error) => console.error('[MCP Error]', error);

          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId: string) => {
              sessions.set(newSessionId, { transport, server, lastUsed: Date.now() });
            },
          });

          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) {
              sessions.delete(sid);
            }
            server.close().catch(() => {});
          };

          this.setupToolHandlers(server);
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
          return;
        }

        // Session ID provided but not found (e.g. after server restart) → 404
        // Per MCP spec, clients must re-initialize on 404
        if (sessionId) {
          res.status(404).json({
            jsonrpc: '2.0',
            error: {
              code: -32001,
              message: 'Session not found',
            },
            id: null,
          });
          return;
        }

        // No session ID and not an initialize request → 400
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: expected initialize request',
          },
          id: null,
        });
      } catch (error) {
        console.error('[MCP] POST error:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error',
            },
            id: null,
          });
        }
      }
    });

    app.get('/mcp', async (req: any, res: any) => {
      const raw = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(raw) ? raw[0] : raw as string | undefined;
      if (!sessionId) {
        res.status(400).send('Missing MCP-Session-Id header');
        return;
      }
      if (!sessions.has(sessionId)) {
        res.status(404).send('Session not found');
        return;
      }

      try {
        const session = sessions.get(sessionId)!;
        session.lastUsed = Date.now();
        await session.transport.handleRequest(req, res);
      } catch (error) {
        console.error('[MCP] GET error:', error);
        if (!res.headersSent) {
          res.status(500).send('Error opening MCP stream');
        }
      }
    });

    app.delete('/mcp', async (req: any, res: any) => {
      const raw = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(raw) ? raw[0] : raw as string | undefined;
      if (!sessionId) {
        res.status(400).send('Missing MCP-Session-Id header');
        return;
      }
      if (!sessions.has(sessionId)) {
        res.status(404).send('Session not found');
        return;
      }

      try {
        const session = sessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
      } catch (error) {
        console.error('[MCP] DELETE error:', error);
        if (!res.headersSent) {
          res.status(500).send('Error closing MCP session');
        }
      }
    });

    app.listen(port, () => {
      console.error(`Seerr MCP server v${VERSION} running on Streamable HTTP port ${port}`);
      console.error(`Supports Seerr and Overseerr (legacy) instances`);
      console.error(`MCP endpoint: http://localhost:${port}/mcp`);
      console.error(`Health check: http://localhost:${port}/health`);
      console.error(`Cache stats: http://localhost:${port}/cache/stats`);
    });
  }
}

const server = new OverseerrServer();

const httpMode = process.env.HTTP_MODE === 'true' || process.argv.includes('--http');
const port = process.env.PORT ? parseInt(process.env.PORT) : 8085;

if (httpMode) {
  server.runHttp(port).catch(console.error);
} else {
  server.run().catch(console.error);
}
