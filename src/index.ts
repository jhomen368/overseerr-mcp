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
import { classifyAvailability } from './utils/availabilityClassifier.js';
import { isTracked } from './utils/mediaStatus.js';
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
  ServiceConfig,
  ServiceDetailsResponse,
} from './types.js';

// Field mapping for includeDetails feature
type FieldMapper = (item: { mediaType: string; id: number }, details: MediaDetails) => any;

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
  'seasons': (item, details) => enrichSeasons(details),

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
  'mediaStatus': (item, details) => details.mediaInfo?.status,
  'hasRequests': (item, details) => (details.mediaInfo?.requests?.length || 0) > 0,
  'requestCount': (item, details) => details.mediaInfo?.requests?.length || 0,
};

/**
 * Enriches seasons array with availability status
 */
function enrichSeasons(details: MediaDetails): DedupeDetails['seasons'] {
  if (!details.seasons || !Array.isArray(details.seasons)) {
    return undefined;
  }
  
  return details.seasons.map(season => {
    // Find status for this season from mediaInfo
    let status = 'NOT_REQUESTED';
    
    if (details.mediaInfo?.seasons) {
      const seasonInfo = details.mediaInfo.seasons.find(s => s.seasonNumber === season.seasonNumber);
      if (seasonInfo) {
        if (seasonInfo.status === 5) {
          status = 'AVAILABLE';
        } else if (seasonInfo.status === 4) {
          status = 'PARTIALLY_AVAILABLE';
        } else if (seasonInfo.status === 3) {
          status = 'PROCESSING';
        } else if (seasonInfo.status === 2) {
          status = 'PENDING';
        }
      }
    }
    
    // Check if this season has been requested
    if (details.mediaInfo?.requests) {
      const hasRequest = details.mediaInfo.requests.some(req =>
        req.media.seasons?.some(s => s.seasonNumber === season.seasonNumber)
      );
      if (hasRequest && status === 'NOT_REQUESTED') {
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
   * Enriches a dedupe result with requested detail fields
   */
  private enrichDedupeResult(
    baseResult: DedupeResult,
    item: { mediaType: string; id: number },
    details: MediaDetails,
    requestedFields: string[],
    seasonNumber?: number | null,
    includeSeason: boolean = true
  ): DedupeResult {
    if (!requestedFields || requestedFields.length === 0) {
      return baseResult;
    }
    
    const enrichedDetails: DedupeDetails = {};
    
    // Extract requested fields using field mappers
    for (const field of requestedFields) {
      const mapper = FIELD_MAP[field];
      if (mapper) {
        const value = mapper(item, details);
        if (value !== undefined && value !== null) {
          (enrichedDetails as any)[field] = value;
        }
      }
    }
    
    // Auto-add targetSeason for TV shows with season number
    if (includeSeason && seasonNumber && item.mediaType === 'tv' && details.seasons) {
      const targetSeasonData = details.seasons.find(s => s.seasonNumber === seasonNumber);
      if (targetSeasonData) {
        // Determine season status
        let seasonStatus = 'NOT_REQUESTED';
        
        if (details.mediaInfo?.seasons) {
          const seasonInfo = details.mediaInfo.seasons.find(s => s.seasonNumber === seasonNumber);
          if (seasonInfo) {
            if (seasonInfo.status === 5) {
              seasonStatus = 'AVAILABLE';
            } else if (seasonInfo.status === 4) {
              seasonStatus = 'PARTIALLY_AVAILABLE';
            } else if (seasonInfo.status === 3) {
              seasonStatus = 'PROCESSING';
            } else if (seasonInfo.status === 2) {
              seasonStatus = 'PENDING';
            }
          }
        }
        
        // Check if requested
        if (details.mediaInfo?.requests) {
          const hasRequest = details.mediaInfo.requests.some(req =>
            req.media.seasons?.some(s => s.seasonNumber === seasonNumber)
          );
          if (hasRequest && seasonStatus === 'NOT_REQUESTED') {
            seasonStatus = 'REQUESTED';
          }
        }
        
        enrichedDetails.targetSeason = {
          seasonNumber: targetSeasonData.seasonNumber,
          episodeCount: targetSeasonData.episodeCount,
          airDate: targetSeasonData.airDate,
          status: seasonStatus,
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
                description: 'Strip "Season N"/"Part N" from titles',
                default: false,
              },
              autoRequest: {
                type: 'boolean',
                description: 'Auto-request passing items (requires dedupeMode)',
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
                description: 'Add details to dedupe results (dedupe only)',
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
                description: 'Check existing',
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
            'Get media details. Single/batch with level control (basic/standard/full).',
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
    const query = args.query!;
    const result = await this.client.search(query, {
      page: args.page || 1,
      language: args.language || 'en',
    });
    return this.formatSearchResponse(result, args.format || 'compact', args.limit);
  }

  private async handleBatchSearch(args: SearchMediaArgs) {
    const queries = args.queries!;
    
    const results = await batchWithRetry(
      queries,
      async (query) => {
        return this.client.search(query, { page: 1, language: args.language || 'en' });
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
              results: this.limitResults(r.result!.results, args.limit).map(item =>
                this.formatCompactResult(item)
              ),
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

    /**
     * Checks whether a season number exists in media details.
     * Prefers the seasons array (authoritative); falls back to numberOfSeasons.
     */
    const doesSeasonExist = (det: MediaDetails, sNum: number): boolean => {
      if (det.seasons?.length) {
        return det.seasons.some(s => s.seasonNumber === sNum);
      }
      if (det.numberOfSeasons !== undefined) {
        return sNum <= det.numberOfSeasons;
      }
      return false;
    };

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
        if (seasonNumber && bestMatch.mediaType === 'tv') {
          if (!doesSeasonExist(details, seasonNumber)) {
            console.error(`[WARN] Season ${seasonNumber} not found in seasons data for "${bestMatch.title || bestMatch.name}". Trying alternates...`);
            let foundValid = false;
            for (const alternate of alternates) {
              if (alternate.mediaType !== 'tv') continue;
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
              return this.enrichDedupeResult(baseResult, { mediaType: 'tv', id: bestMatch.id }, details, requestedFields, seasonNumber, includeSeason);
            }
          }
        }

        // ── 5. Classify ────────────────────────────────────────────────────────
        const mediaType = bestMatch.mediaType as 'movie' | 'tv';
        const showSeasons = mediaType === 'tv'
          ? details.seasons?.filter(s => s.seasonNumber > 0)
          : undefined;
        const requestedSeasons = args.requestOptions?.seasons && args.requestOptions.seasons !== 'all'
          ? (args.requestOptions.seasons as number[])
          : undefined;

        const classified = classifyAvailability(details.mediaInfo, mediaType, seasonNumber, {
          showSeasons,
          requestedSeasons,
        });

        // ── 6. Build franchiseInfo (orchestrator assembles display string) ─────
        const showName = details.name || details.title || bestMatch.name || bestMatch.title || '';
        let franchiseInfo: string | undefined;

        if (mediaType === 'tv' && showName) {
          if (seasonNumber !== null) {
            franchiseInfo = `Season ${seasonNumber} of ${showName}`;
          } else {
            const availableNums = details.mediaInfo?.seasons
              ?.filter(s => s.seasonNumber > 0 && isTracked(s.status))
              .map(s => s.seasonNumber)
              .sort((a, b) => a - b) ?? [];
            const requestedNums = details.mediaInfo?.requests
              ?.flatMap(req => req.media.seasons?.filter(s => s.seasonNumber > 0).map(s => s.seasonNumber) ?? [])
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
        return this.enrichDedupeResult(baseResult, { mediaType, id: bestMatch.id }, details, requestedFields, seasonNumber, includeSeason);
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
          if (seasonNumber) {
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
      // Check if this is a dry run
      const isDryRun = args.requestOptions?.dryRun === true;

      if (isDryRun) {
        // Dry run - don't actually request, just show what would be requested
        autoRequestResults = {
          dryRun: true,
          totalQueued: autoRequestQueue.length,
          wouldRequest: autoRequestQueue.map(item => ({
            mediaType: item.mediaType,
            mediaId: item.mediaId,
            seasons: item.seasons,
          })),
          message: 'Dry run - no requests were made. Remove "dryRun: true" from requestOptions to actually request.',
        };
      } else {
        // Actually make the requests
        const requestResults = await batchWithRetry(
          autoRequestQueue,
          async (item) => {
            try {
              // Expand "all" to actual season numbers (excluding season 0 - specials)
              let seasonsToRequest = item.seasons;
              if (item.mediaType === 'tv' && item.seasons === 'all') {
                const details = await this.client.getMediaDetails('tv', item.mediaId);
                
                // Get all regular seasons excluding season 0 (specials)
                const regularSeasons = details.seasons?.filter(s => s.seasonNumber > 0) || [];
                seasonsToRequest = regularSeasons.map(s => s.seasonNumber);
                
                // If no regular seasons found, fall back to numberOfSeasons
                if (seasonsToRequest.length === 0 && details.numberOfSeasons) {
                  seasonsToRequest = Array.from({ length: details.numberOfSeasons }, (_, i) => i + 1);
                  // Filter out season 0 if it's in the list
                  seasonsToRequest = seasonsToRequest.filter(s => s > 0);
                }
              }

              const requestBody: any = {
                mediaType: item.mediaType,
                mediaId: item.mediaId,
                is4k: args.requestOptions?.is4k || false,
              };

              if (item.mediaType === 'tv' && seasonsToRequest) {
                requestBody.seasons = seasonsToRequest;
              }
              if (args.requestOptions?.serverId) requestBody.serverId = args.requestOptions.serverId;
              if (args.requestOptions?.profileId) requestBody.profileId = args.requestOptions.profileId;
              if (args.requestOptions?.rootFolder) requestBody.rootFolder = args.requestOptions.rootFolder;

              const createdRequest = await this.client.createRequest(requestBody);

              return {
                success: true,
                requestId: createdRequest.id,
                mediaId: item.mediaId,
                mediaType: item.mediaType,
                seasons: seasonsToRequest,
                status: createdRequest.status
              };
            } catch (error: any) {
              return {
                success: false,
                mediaId: item.mediaId,
                mediaType: item.mediaType,
                error: (error as any).response?.data?.message || (error as any).message || 'Unknown error',
              };
            }
          }
        );

        const successfulRequests = requestResults.filter(r => r.success && r.result?.success);
        const failedRequests = requestResults.filter(r => !r.success || !r.result?.success);

        autoRequestResults = {
          executed: true,
          totalRequested: autoRequestQueue.length,
          successful: successfulRequests.length,
          failed: failedRequests.length,
          requests: successfulRequests.map(r => r.result),
          errors: failedRequests.map(r => ({
            mediaId: r.item.mediaId,
            mediaType: r.item.mediaType,
            error: r.result?.error?.message || r.result?.error || 'Unknown error',
          })),
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

  private async handleSingleRequest(args: RequestMediaArgs) {
    const { mediaType, mediaId, seasons, is4k, validateFirst, dryRun, confirmed } = args;

    // Validate TV show requests have seasons specified
    if (mediaType === 'tv' && !seasons) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'seasons parameter is required for TV show requests. Use seasons: [1,2,3] for specific seasons or seasons: "all" for all seasons.'
      );
    }

    // Expand "all" to actual season numbers (excluding season 0) early in the function
    let expandedSeasons: number[] | undefined = undefined;
    if (mediaType === 'tv' && seasons) {
      if (seasons === 'all') {
        const details = await this.client.getMediaDetails(mediaType as 'movie' | 'tv', mediaId!);
        
        // Get all regular seasons (exclude season 0 - specials)
        const regularSeasons = details.seasons?.filter(s => s.seasonNumber > 0) || [];
        expandedSeasons = regularSeasons.map(s => s.seasonNumber);
        
        // If no regular seasons found, fall back to numberOfSeasons
        if (expandedSeasons.length === 0 && details.numberOfSeasons) {
          expandedSeasons = Array.from({ length: details.numberOfSeasons }, (_, i) => i + 1);
        }
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

    // Validate first if requested
    if (validateFirst) {
      const details = await this.client.getMediaDetails(mediaType as 'movie' | 'tv', mediaId!);

      const mediaInfo = details.mediaInfo;
      if (mediaInfo?.requests && mediaInfo.requests.length > 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                status: 'ALREADY_REQUESTED',
                message: `${details.title || details.name} is already requested`,
                existingRequests: mediaInfo.requests.map(r => ({
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

      if (mediaInfo?.status != null && [2, 3, 4, 5].includes(mediaInfo.status)) { // PENDING, PROCESSING, PARTIALLY_AVAILABLE, or AVAILABLE
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
        // Get details to calculate episode count
        const details = await this.client.getMediaDetails(mediaType as 'movie' | 'tv', mediaId!);

        const totalSeasons = details.numberOfSeasons || 0;
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

    // Guard: reject empty seasons before dry-run or real request — avoids silent success with no actual request
    if (mediaType === 'tv' && (!expandedSeasons || expandedSeasons.length === 0)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'No valid seasons specified. Use seasons: [1, 2, 3] for specific seasons or seasons: "all" for all seasons.'
      );
    }

    // Get media title with caching
    const details = await this.client.getMediaDetails(mediaType as 'movie' | 'tv', mediaId!);
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

    // Use expandedSeasons (array) to ensure season 0 is not included
    if (mediaType === 'tv' && expandedSeasons) {
      requestBody.seasons = expandedSeasons;
    }

    if (args.serverId) requestBody.serverId = args.serverId;
    if (args.profileId) requestBody.profileId = args.profileId;
    if (args.rootFolder) requestBody.rootFolder = args.rootFolder;

    const createdRequest = await this.client.createRequest(requestBody);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            requestId: createdRequest.id,
            status: this.getStatusString(createdRequest.status),
            message: `Successfully requested ${mediaTitle}`,
            seasonsRequested: createdRequest.seasons?.map((s: any) => s.seasonNumber),
          }, null, 2),
        },
      ],
    };
  }

  private async handleBatchRequest(args: RequestMediaArgs) {
    const items = args.items!;

    const results = await batchWithRetry(
      items,
      async (item) => {
        const singleArgs = {
          ...args,
          mediaType: item.mediaType,
          mediaId: item.mediaId,
          seasons: item.seasons,
          is4k: item.is4k,
          items: undefined,
        };
        
        const result = await this.handleSingleRequest(singleArgs);
        return JSON.parse(result.content[0].text);
      }
    );

    const successful = results.filter(r => r.success && r.result?.success);
    const failed = results.filter(r => !r.success || !r.result?.success);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary: {
              total: items.length,
              successful: successful.length,
              failed: failed.length,
            },
            results: successful.map(r => r.result),
            errors: failed.map(r => ({
              item: r.item,
              error: r.error?.message || r.result?.message || 'Unknown error',
            })),
          }, null, 2),
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

  private async formatSearchResponse(result: SearchResult, format: string, limit?: number) {
    const limitedResults = this.limitResults(result.results, limit);

    if (format === 'compact') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              total: result.totalResults,
              results: limitedResults.map(item => 
                this.formatCompactResult(item)
              ),
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
            results: limitedResults,
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
      seasons: request.media.seasons?.map(s => ({
        number: s.seasonNumber,
        status: this.getMediaStatusString(s.status),
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
      // Map all tracked media statuses (PENDING/PROCESSING/PARTIALLY_AVAILABLE/AVAILABLE)
      // using the canonical getMediaStatusString mapping, not just status === 5
      if (info.status && info.status >= 2 && info.status <= 5) {
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
    const statusMap: { [key: number]: string } = {
      1: 'UNKNOWN',
      2: 'PENDING',
      3: 'PROCESSING',
      4: 'PARTIALLY_AVAILABLE',
      5: 'AVAILABLE',
      6: 'DELETED',
    };
    return statusMap[status] || 'UNKNOWN';
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
