#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance } from 'axios';
import { CacheManager } from './utils/cache.js';
import { normalizeTitle, extractSeasonNumber, inferExpectedMediaType, selectBestMatch, encodeSearchQuery } from './utils/normalize.js';
import { withRetry, batchWithRetry } from './utils/retry.js';
import {
  SearchResult,
  MediaRequest,
  MediaDetails,
  SearchMediaArgs,
  RequestMediaArgs,
  ManageRequestsArgs,
  GetDetailsArgs,
  DedupeResult,
  CompactMediaResult,
  MediaInfo,
  DedupeDetails,
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
      status,
    };
  });
}

const OVERSEERR_URL = process.env.OVERSEERR_URL;
const OVERSEERR_API_KEY = process.env.OVERSEERR_API_KEY;

if (!OVERSEERR_URL || !OVERSEERR_API_KEY) {
  throw new Error(
    'OVERSEERR_URL and OVERSEERR_API_KEY environment variables are required'
  );
}

class OverseerrServer {
  private server: Server;
  private axiosInstance: AxiosInstance;
  private cache: CacheManager;

  constructor() {
    this.server = new Server(
      {
        name: 'overseerr-mcp',
        version: '1.2.1',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.axiosInstance = axios.create({
      baseURL: `${OVERSEERR_URL}/api/v1`,
      headers: {
        'X-Api-Key': OVERSEERR_API_KEY,
        'Content-Type': 'application/json',
      },
    });

    this.cache = new CacheManager();
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

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'search_media',
          description:
            'Search movies/TV shows with single, batch, or dedupe modes. Dedupe mode checks availability and returns actionable status for batch processing.\n\n' +
            'Modes: single query | multi-query batch | dedupe (availability check)\n' +
            'Workflows: Pass 1 dedupe → Pass 2 autoRequest | manual dedupe → selective request_media\n' +
            'Status codes: NOT_FOUND, ALREADY_AVAILABLE, ALREADY_REQUESTED, SEASON_AVAILABLE, SEASON_REQUESTED, AVAILABLE_FOR_REQUEST',
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
                description: 'Enable batch dedupe checking (optimized for Pass 1 workflow)',
                default: false,
              },
              titles: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of titles to check in dedupe mode',
              },
              autoNormalize: {
                type: 'boolean',
                description: 'Auto-normalize titles (strip Season N, Part N, etc.)',
                default: false,
              },
              autoRequest: {
                type: 'boolean',
                description: 'Auto-request items that pass dedupe check (Pass 2 workflow - requires dedupeMode)',
                default: false,
              },
              requestOptions: {
                type: 'object',
                description: 'Options for auto-request functionality (only used when autoRequest is true)',
                properties: {
                  seasons: {
                    oneOf: [
                      { type: 'array', items: { type: 'number' } },
                      { type: 'string', enum: ['all'] },
                    ],
                    description: 'Seasons to request for TV shows',
                  },
                  is4k: {
                    type: 'boolean',
                    description: 'Request 4K version',
                    default: false,
                  },
                  serverId: { type: 'number' },
                  profileId: { type: 'number' },
                  rootFolder: { type: 'string' },
                  dryRun: {
                    type: 'boolean',
                    description: 'Preview auto-requests without actually requesting',
                    default: false,
                  },
                },
              },
              checkAvailability: {
                type: 'boolean',
                description: 'Check if results are already requested/available (slower, fetches details for each result)',
                default: false,
              },
              format: {
                type: 'string',
                enum: ['compact', 'standard', 'full'],
                description: 'Response format (default: compact)',
                default: 'compact',
              },
              limit: {
                type: 'number',
                description: 'Max results to return',
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
                description: 'Include additional media details in dedupe results (dedupe mode only). Enriches results with specific fields from cached data.',
                properties: {
                  fields: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 
                      'Fields to include. Available fields:\n' +
                      '• Basic (no extra cost): mediaType, year, posterPath\n' +
                      '• Standard (from cache): rating, overview, genres, runtime\n' +
                      '• TV-Specific: numberOfSeasons, numberOfEpisodes, seasons (with availability status)\n' +
                      '• Advanced: releaseDate, firstAirDate, originalTitle, originalName, popularity, backdropPath, homepage, status, tagline\n' +
                      '• Availability: mediaStatus, hasRequests, requestCount\n' +
                      'Note: targetSeason is auto-added for titles with season numbers when seasons field is requested',
                  },
                  includeSeason: {
                    type: 'boolean',
                    description: 'Auto-include targetSeason info for TV shows with season in title (default: true)',
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
            'Request media with auto-confirmation for TV shows ≤24 episodes. Supports single or batch mode with validation and dry-run.\n\n' +
            'Auto-confirmation: Movies always | TV ≤24 episodes | TV >24 episodes requires confirmed:true\n' +
            'Typical flow: dedupe results → request_media (batch or single)\n' +
            'Validation: validateFirst (default) checks duplicates | dryRun previews without requesting\n' +
            'TV shows require seasons parameter (array or "all")',
          inputSchema: {
            type: 'object',
            properties: {
              mediaType: {
                type: 'string',
                enum: ['movie', 'tv'],
                description: 'Media type (single mode)',
              },
              mediaId: {
                type: 'number',
                description: 'TMDB ID (single mode)',
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
                      description: 'Seasons to request (REQUIRED for TV shows, not used for movies)',
                    },
                    is4k: { type: 'boolean' },
                  },
                  required: ['mediaType', 'mediaId'],
                },
                description: 'Multiple items to request (batch mode)',
              },
              seasons: {
                oneOf: [
                  { type: 'array', items: { type: 'number' } },
                  { type: 'string', enum: ['all'] },
                ],
                description: 'Seasons to request (TV shows)',
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
                description: 'Check if already requested',
                default: true,
              },
              dryRun: {
                type: 'boolean',
                description: 'Preview without requesting',
                default: false,
              },
              confirmed: {
                type: 'boolean',
                description: 'Confirm multi-season request',
                default: false,
              },
            },
          },
        },
        {
          name: 'manage_media_requests',
          description:
            'Manage media requests with get, list, approve, decline, delete actions. List supports summary mode and status filtering.\n\n' +
            'Actions: get (single) | list (paginated/summary) | approve/decline/delete (single/batch)\n' +
            'Filters: all, pending, approved, available, processing, unavailable, failed',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['get', 'list', 'approve', 'decline', 'delete'],
                description: 'Action to perform',
              },
              requestId: {
                type: 'number',
                description: 'Request ID (single operations)',
              },
              requestIds: {
                type: 'array',
                items: { type: 'number' },
                description: 'Request IDs (batch operations)',
              },
              format: {
                type: 'string',
                enum: ['compact', 'standard', 'full'],
                default: 'compact',
              },
              summary: {
                type: 'boolean',
                description: 'Return summary stats instead of full list',
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
            'Get media information with level control. Supports single item or batch lookup.\n\n' +
            'Levels: basic (core data) | standard (with genres/runtime) | full (all fields)\n' +
            'Fields: specify exact fields as alternative to level',
          inputSchema: {
            type: 'object',
            properties: {
              mediaType: {
                type: 'string',
                enum: ['movie', 'tv'],
                description: 'Media type (single mode)',
              },
              mediaId: {
                type: 'number',
                description: 'TMDB ID (single mode)',
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
                description: 'Multiple items (batch mode)',
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
                description: 'Specific fields to return',
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
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
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
                text: `Overseerr API error (${status}): ${message}`,
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
    const cacheKey = { query, page: args.page || 1, language: args.language || 'en' };
    
    // Check cache
    const cached = this.cache.get<SearchResult>('search', cacheKey);
    if (cached) {
      return this.formatSearchResponse(cached, args.format || 'compact', args.limit);
    }

    // Search with retry - build URL manually with encoded query
    const result = await withRetry(async () => {
      const encodedQuery = encodeSearchQuery(query);
      const page = args.page || 1;
      const language = args.language || 'en';
      const url = `/search?query=${encodedQuery}&page=${page}&language=${language}`;
      const response = await this.axiosInstance.get<SearchResult>(url);
      return response.data;
    });

    // Cache result
    this.cache.set('search', cacheKey, result);

    return this.formatSearchResponse(result, args.format || 'compact', args.limit);
  }

  private async handleBatchSearch(args: SearchMediaArgs) {
    const queries = args.queries!;
    
    const results = await batchWithRetry(
      queries,
      async (query) => {
        const cacheKey = { query, page: 1, language: args.language || 'en' };
        const cached = this.cache.get<SearchResult>('search', cacheKey);
        if (cached) return cached;

        // Build URL manually with encoded query
        const encodedQuery = encodeSearchQuery(query);
        const language = args.language || 'en';
        const url = `/search?query=${encodedQuery}&page=1&language=${language}`;
        const response = await this.axiosInstance.get<SearchResult>(url);
        const data = response.data;
        this.cache.set('search', cacheKey, data);
        return data;
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

    const processedTitles = await batchWithRetry(
      titles,
      async (originalTitle) => {
        // Normalize title if requested
        const searchTitle = autoNormalize ? normalizeTitle(originalTitle) : originalTitle;
        const seasonNumber = extractSeasonNumber(originalTitle);

        // Search for the title - build URL manually with encoded query
        const cacheKey = { query: searchTitle, page: 1, language: args.language || 'en' };
        let searchResult = this.cache.get<SearchResult>('search', cacheKey);
        
        if (!searchResult) {
          const encodedQuery = encodeSearchQuery(searchTitle);
          const language = args.language || 'en';
          const url = `/search?query=${encodedQuery}&page=1&language=${language}`;
          const response = await this.axiosInstance.get<SearchResult>(url);
          searchResult = response.data;
          this.cache.set('search', cacheKey, searchResult);
        }

        // If no results, it's a pass (not in system)
        if (!searchResult.results || searchResult.results.length === 0) {
          // Not found since NOT_FOUND items cannot be requested
          const baseResult: DedupeResult = {
            title: originalTitle,
            id: 0,
            mediaType: undefined,  // Unknown since not found
            status: 'blocked' as const,
            reasonCode: 'NOT_FOUND',
            isActionable: false,
            note: 'Not found in TMDB',
          };
          // No enrichment for not found items
          return baseResult;
        }

        // Smart result selection with media type validation
        const expectedType = inferExpectedMediaType(originalTitle);
        const selection = selectBestMatch(searchResult.results, expectedType, searchTitle);
        let bestMatch = selection.match;
        let alternates = selection.alternates;
        
        // Log low confidence matches for debugging
        if (selection.confidence === 'low') {
          console.error(`[WARN] Low confidence match for "${originalTitle}": expected ${expectedType}, got ${bestMatch.mediaType} (${bestMatch.title || bestMatch.name})`);
        }
        
        // For season-specific queries, validate season number exists in matched series
        if (seasonNumber && bestMatch.mediaType === 'tv') {
          // Fetch details to check numberOfSeasons
          const detailsCacheKey = { mediaType: 'tv', mediaId: bestMatch.id };
          let details = this.cache.get<MediaDetails>('mediaDetails', detailsCacheKey);
          
          if (!details) {
            const detailsResponse = await this.axiosInstance.get<MediaDetails>(`/tv/${bestMatch.id}`);
            details = detailsResponse.data;
            details.mediaType = 'tv';
            this.cache.set('mediaDetails', detailsCacheKey, details);
          }
          
          // Validate: if requested season > total seasons, try alternates
          if (details.numberOfSeasons && seasonNumber > details.numberOfSeasons) {
            console.error(`[WARN] Season ${seasonNumber} requested but "${bestMatch.title || bestMatch.name}" only has ${details.numberOfSeasons} seasons. Trying alternates...`);
            
            // Try each alternate
            let foundValid = false;
            for (const alternate of alternates) {
              if (alternate.mediaType !== 'tv') continue;
              
              const altCacheKey = { mediaType: 'tv', mediaId: alternate.id };
              let altDetails = this.cache.get<MediaDetails>('mediaDetails', altCacheKey);
              
              if (!altDetails) {
                const altResponse = await this.axiosInstance.get<MediaDetails>(`/tv/${alternate.id}`);
                altDetails = altResponse.data;
                altDetails.mediaType = 'tv';
                this.cache.set('mediaDetails', altCacheKey, altDetails);
              }
              
              // Check if this alternate has enough seasons
              if (altDetails.numberOfSeasons && seasonNumber <= altDetails.numberOfSeasons) {
                console.error(`[INFO] Found valid alternate: "${alternate.title || alternate.name}" with ${altDetails.numberOfSeasons} seasons`);
                bestMatch = alternate;
                details = altDetails;
                foundValid = true;
                break;
              }
            }
            
            // If no valid match found, return NOT_FOUND
            if (!foundValid) {
              return {
                title: originalTitle,
                id: 0,
                mediaType: undefined,
                status: 'blocked' as const,
                reasonCode: 'NOT_FOUND',
                isActionable: false,
                note: `Season ${seasonNumber} not found - no matching series with that many seasons`
              };
            }
          }
        }
        
        // Check if it's TV and we need details for season checking
        if (bestMatch.mediaType === 'tv') {
          const detailsCacheKey = { mediaType: 'tv', mediaId: bestMatch.id };
          let details = this.cache.get<MediaDetails>('mediaDetails', detailsCacheKey);
          
          if (!details) {
            const detailsResponse = await this.axiosInstance.get<MediaDetails>(
              `/tv/${bestMatch.id}`
            );
            details = detailsResponse.data;
            // Add mediaType to details for enrichment
            details.mediaType = 'tv';
            this.cache.set('mediaDetails', detailsCacheKey, details);
          }

          // Get media info for status checking
          const mediaInfo = details.mediaInfo;
          
          // CASE 1: Specific season mentioned in title
          if (seasonNumber) {
            // Check if this specific season is in library (PENDING, PROCESSING, PARTIALLY_AVAILABLE, or AVAILABLE)
            // Do NOT block: UNKNOWN(1), DELETED(6), or missing
            const targetSeasonInfo = mediaInfo?.seasons?.find(s => s.seasonNumber === seasonNumber);
            if (targetSeasonInfo && [2, 3, 4, 5].includes(targetSeasonInfo.status)) {
              const statusStr = this.getMediaStatusString(targetSeasonInfo.status);
              const baseResult: DedupeResult = {
                title: originalTitle,
                id: bestMatch.id,
                mediaType: 'tv',
                status: 'blocked' as const,
                reason: `Season ${seasonNumber} is ${statusStr.toLowerCase()}`,
                reasonCode: 'SEASON_AVAILABLE',
                isActionable: false,
                franchiseInfo: `Season ${seasonNumber} of ${details.name || bestMatch.name}`,
              };
              if (requestedFields.length > 0) {
                return {
                  result: this.enrichDedupeResult(
                    baseResult,
                    { mediaType: 'tv', id: bestMatch.id },
                    details,
                    requestedFields,
                    seasonNumber,
                    includeSeason
                  )
                };
              }
              return { result: baseResult };
            }
            
            // Check if this specific season is requested
            const seasonRequested = mediaInfo?.requests?.some(req =>
              req.media.seasons?.some(s => s.seasonNumber === seasonNumber)
            );
            if (seasonRequested) {
              const baseResult: DedupeResult = {
                title: originalTitle,
                id: bestMatch.id,
                mediaType: 'tv',
                status: 'blocked' as const,
                reason: `Season ${seasonNumber} is already requested`,
                reasonCode: 'SEASON_REQUESTED',
                isActionable: false,
                franchiseInfo: `Season ${seasonNumber} of ${details.name || bestMatch.name}`,
              };
              if (requestedFields.length > 0) {
                return {
                  result: this.enrichDedupeResult(
                    baseResult,
                    { mediaType: 'tv', id: bestMatch.id },
                    details,
                    requestedFields,
                    seasonNumber,
                    includeSeason
                  )
                };
              }
              return { result: baseResult };
            }
            
            // Specific season not in library/requested - it's a pass
            const baseResult: DedupeResult = {
              title: originalTitle,
              id: bestMatch.id,
              mediaType: 'tv',
              status: 'pass' as const,
              reasonCode: 'AVAILABLE_FOR_REQUEST',
              isActionable: true,
              franchiseInfo: `Season ${seasonNumber} of ${details.name || bestMatch.name}`,
            };
            // Auto-add enhanced details if requested
            if (requestedFields.length > 0) {
              return {
                result: this.enrichDedupeResult(
                  baseResult,
                  { mediaType: 'tv', id: bestMatch.id },
                  details,
                  requestedFields,
                  seasonNumber,
                  includeSeason
                )
              };
            }
            return { result: baseResult };
          }
          
          // CASE 2: No specific season mentioned - check base series availability
          // BUG FIX: Check show-level status FIRST before checking individual seasons
          // This catches shows marked as AVAILABLE at show level even without complete season data
          if (mediaInfo && [5].includes(mediaInfo.status)) {
            const baseResult: DedupeResult = {
              title: originalTitle,
              id: bestMatch.id,
              mediaType: 'tv',
              status: 'blocked' as const,
              reason: `Already in library (show-level)`,
              reasonCode: 'ALREADY_AVAILABLE',
              isActionable: false,
              franchiseInfo: `${details.name || bestMatch.name}`,
            };
            if (requestedFields.length > 0) {
              return this.enrichDedupeResult(baseResult, { mediaType: 'tv', id: bestMatch.id }, details, requestedFields, null, includeSeason);
            }
            return { result: baseResult };
          }
          
          // Check if there are show-level requests (not season-specific)
          if (mediaInfo?.requests && mediaInfo.requests.length > 0) {
            const hasShowLevelRequest = mediaInfo.requests.some(req =>
              !req.media.seasons || req.media.seasons.length === 0
            );
            if (hasShowLevelRequest) {
              const baseResult: DedupeResult = {
                title: originalTitle,
                id: bestMatch.id,
                mediaType: 'tv',
                status: 'blocked' as const,
                reason: 'Already requested (show-level)',
                reasonCode: 'ALREADY_REQUESTED',
                isActionable: false,
                franchiseInfo: `${details.name || bestMatch.name}`,
              };
              if (requestedFields.length > 0) {
                return this.enrichDedupeResult(baseResult, { mediaType: 'tv', id: bestMatch.id }, details, requestedFields, null, includeSeason);
              }
              return { result: baseResult };
            }
          }
          
          // Now check individual seasons
          const regularSeasons = details.seasons?.filter(s => s.seasonNumber > 0) || [];
          
          if (regularSeasons.length > 0) {
            // Check if ALL regular seasons are in library (statuses 2-5)
            const allSeasonsAvailable = regularSeasons.every(season => {
              const seasonInfo = mediaInfo?.seasons?.find(s => s.seasonNumber === season.seasonNumber);
              return seasonInfo && [2, 3, 4, 5].includes(seasonInfo.status);
            });
            
            if (allSeasonsAvailable && mediaInfo?.seasons && mediaInfo.seasons.length > 0) {
              const availableSeasons = mediaInfo.seasons.filter(s => s.seasonNumber > 0 && [2, 3, 4, 5].includes(s.status)).map(s => s.seasonNumber).sort((a, b) => a - b);
              const baseResult: DedupeResult = {
                title: originalTitle,
                id: bestMatch.id,
                mediaType: 'tv',
                status: 'blocked' as const,
                reason: `All regular seasons already in library`,
                reasonCode: 'ALREADY_AVAILABLE',
                isActionable: false,
                franchiseInfo: `${details.name || bestMatch.name} - All ${availableSeasons.length} seasons in library (S${availableSeasons.join(', S')})`,
              };
              if (requestedFields.length > 0) {
                return this.enrichDedupeResult(baseResult, { mediaType: 'tv', id: bestMatch.id }, details, requestedFields, null, includeSeason);
              }
              return { result: baseResult };
            }
            
            // Check if ALL regular seasons are requested
            const allSeasonsRequested = regularSeasons.every(season => {
              return mediaInfo?.requests?.some(req =>
                req.media.seasons?.some(s => s.seasonNumber === season.seasonNumber)
              );
            });
            
            if (allSeasonsRequested && mediaInfo?.requests && mediaInfo.requests.length > 0) {
              const requestedSeasons = regularSeasons.filter(season =>
                mediaInfo.requests?.some(req => req.media.seasons?.some(s => s.seasonNumber === season.seasonNumber))
              ).map(s => s.seasonNumber).sort((a, b) => a - b);
              const baseResult: DedupeResult = {
                title: originalTitle,
                id: bestMatch.id,
                mediaType: 'tv',
                status: 'blocked' as const,
                reason: `All regular seasons already requested`,
                reasonCode: 'ALREADY_REQUESTED',
                isActionable: false,
                franchiseInfo: `${details.name || bestMatch.name} - All ${requestedSeasons.length} seasons requested (S${requestedSeasons.join(', S')})`,
              };
              if (requestedFields.length > 0) {
                return this.enrichDedupeResult(baseResult, { mediaType: 'tv', id: bestMatch.id }, details, requestedFields, null, includeSeason);
              }
              return { result: baseResult };
            }
            
            // Partial availability/requests - check enhanced franchise info
            let availableSeasons = mediaInfo?.seasons?.filter(s => s.seasonNumber > 0 && [2, 3, 4, 5].includes(s.status)).map(s => s.seasonNumber).sort((a, b) => a - b) || [];
            let requestedSeasons = regularSeasons.filter(season =>
              mediaInfo?.requests?.some(req => req.media.seasons?.some(s => s.seasonNumber === season.seasonNumber))
            ).map(s => s.seasonNumber).sort((a, b) => a - b);
            
            // Build enhanced franchise info
            let franchiseInfo = `${details.name || bestMatch.name}`;
            if (availableSeasons.length > 0 || requestedSeasons.length > 0) {
              const statusParts = [];
              if (availableSeasons.length > 0) {
                statusParts.push(`${availableSeasons.length} in library (S${availableSeasons.join(', S')})`);
              }
              if (requestedSeasons.length > 0) {
                statusParts.push(`${requestedSeasons.length} requested (S${requestedSeasons.join(', S')})`);
              }
              franchiseInfo += ` - ${statusParts.join(', ')}`;
            }
            
            // Some seasons in library/requested, but not all - it's a pass
            const baseResult: DedupeResult = {
              title: originalTitle,
              id: bestMatch.id,
              mediaType: 'tv',
              status: 'pass' as const,
              reasonCode: 'AVAILABLE_FOR_REQUEST',
              isActionable: true,
              franchiseInfo: franchiseInfo,
            };
            // Auto-add enhanced details if requested
            if (requestedFields.length > 0) {
              return this.enrichDedupeResult(baseResult, { mediaType: 'tv', id: bestMatch.id }, details, requestedFields, null, includeSeason);
            }
            return { result: baseResult };
          }
          
          // Fallback: No seasons info available, check overall status
          if (mediaInfo && [2, 3, 4, 5].includes(mediaInfo.status)) {
            const statusStr = this.getMediaStatusString(mediaInfo.status);
            const baseResult: DedupeResult = {
              title: originalTitle,
              id: bestMatch.id,
              mediaType: 'tv',
              status: 'blocked' as const,
              reason: `Already in library (${statusStr.toLowerCase()})`,
              reasonCode: 'ALREADY_AVAILABLE',
              isActionable: false,
            };
            // Enrich if details requested
            if (requestedFields.length > 0) {
              return {
                result: this.enrichDedupeResult(
                  baseResult,
                  { mediaType: 'tv', id: bestMatch.id },
                  details,
                  requestedFields,
                  null,
                  includeSeason
                )
              };
            }
            return { result: baseResult };
          }
          
          if (mediaInfo?.requests && mediaInfo.requests.length > 0) {
            const baseResult: DedupeResult = {
              title: originalTitle,
              id: bestMatch.id,
              mediaType: 'tv',
              status: 'blocked' as const,
              reason: 'Already requested',
              reasonCode: 'ALREADY_REQUESTED',
              isActionable: false,
            };
            // Enrich if details requested
            if (requestedFields.length > 0) {
              return {
                result: this.enrichDedupeResult(
                  baseResult,
                  { mediaType: 'tv', id: bestMatch.id },
                  details,
                  requestedFields,
                  null,
                  includeSeason
                )
              };
            }
            return { result: baseResult };
          }
          
          // Not requested - it's a pass
          const baseResult: DedupeResult = {
            title: originalTitle,
            id: bestMatch.id,
            mediaType: 'tv',
            status: 'pass' as const,
            reasonCode: 'AVAILABLE_FOR_REQUEST',
            isActionable: true,
          };
          
          // Enrich if details requested
          if (requestedFields.length > 0) {
            return {
              result: this.enrichDedupeResult(
                baseResult,
                { mediaType: 'tv', id: bestMatch.id },
                details,
                requestedFields,
                null,
                includeSeason
              )
            };
          }
          return { result: baseResult };
        } else {
          // Movie - simpler check
          const detailsCacheKey = { mediaType: 'movie', mediaId: bestMatch.id };
          let details = this.cache.get<MediaDetails>('mediaDetails', detailsCacheKey);
          
          if (!details) {
            const detailsResponse = await this.axiosInstance.get<MediaDetails>(
              `/movie/${bestMatch.id}`
            );
            details = detailsResponse.data;
            // Add mediaType to details for enrichment
            details.mediaType = 'movie';
            this.cache.set('mediaDetails', detailsCacheKey, details);
          }

          const mediaInfo = details.mediaInfo;
          if (mediaInfo && mediaInfo.status) {
            const statusStr = this.getMediaStatusString(mediaInfo.status);
            
            // Check if movie is in library (statuses 2-5)
            if ([2, 3, 4, 5].includes(mediaInfo.status)) {
              const baseResult: DedupeResult = {
                title: originalTitle,
                id: bestMatch.id,
                mediaType: 'movie',
                status: 'blocked' as const,
                reason: `Already in library (${statusStr.toLowerCase()})`,
                reasonCode: 'ALREADY_AVAILABLE',
                isActionable: false,
              };
              // Enrich if details requested
              if (requestedFields.length > 0) {
                return {
                  result: this.enrichDedupeResult(
                    baseResult,
                    { mediaType: 'movie', id: bestMatch.id },
                    details,
                    requestedFields,
                    null,
                    includeSeason
                  )
                };
              }
              return { result: baseResult };
            }
            
            if (mediaInfo.requests && mediaInfo.requests.length > 0) {
              const baseResult: DedupeResult = {
                title: originalTitle,
                id: bestMatch.id,
                mediaType: 'movie',
                status: 'blocked' as const,
                reason: 'Already requested',
                reasonCode: 'ALREADY_REQUESTED',
                isActionable: false,
              };
              // Enrich if details requested
              if (requestedFields.length > 0) {
                return {
                  result: this.enrichDedupeResult(
                    baseResult,
                    { mediaType: 'movie', id: bestMatch.id },
                    details,
                    requestedFields,
                    null,
                    includeSeason
                  )
                };
              }
              return { result: baseResult };
            }
          }
          
          // Not requested - it's a pass
          const baseResult: DedupeResult = {
            title: originalTitle,
            id: bestMatch.id,
            mediaType: 'movie',
            status: 'pass' as const,
            reasonCode: 'AVAILABLE_FOR_REQUEST',
            isActionable: true,
          };
          
          // Enrich if details requested
          if (requestedFields.length > 0) {
            return {
              result: this.enrichDedupeResult(
                baseResult,
                { mediaType: 'movie', id: bestMatch.id },
                details,
                requestedFields,
                null,
                includeSeason
              )
            };
          }
          return { result: baseResult };
        }
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
      } else {
        dedupeResults.push({
          title: result.item,
          id: 0,
          mediaType: undefined,  // Ensure undefined for errors (Bug #13)
          status: 'blocked', // Changed to pass for NOT_FOUND items not in library
          reasonCode: 'NOT_FOUND',
          isActionable: false,
        });
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
              const requestBody: any = {
                mediaType: item.mediaType,
                mediaId: item.mediaId,
                is4k: args.requestOptions?.is4k || false,
              };

              if (item.mediaType === 'tv' && item.seasons) {
                requestBody.seasons = item.seasons;
              }
              if (args.requestOptions?.serverId) requestBody.serverId = args.requestOptions.serverId;
              if (args.requestOptions?.profileId) requestBody.profileId = args.requestOptions.profileId;
              if (args.requestOptions?.rootFolder) requestBody.rootFolder = args.requestOptions.rootFolder;

              const response = await this.axiosInstance.post('/request', requestBody);
              
              // Invalidate caches
              this.cache.invalidate('requests');
              this.cache.invalidate('mediaDetails');

              return {
                success: true,
                requestId: response.data.id,
                mediaId: item.mediaId,
                mediaType: item.mediaType,
                seasons: item.seasons,
                status: response.data.status
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
          enqueue: true,
          totalRequested: autoRequestQueue.length,
          successful: successfulRequests.length,
          failed: failedRequests.length,
          requests: successfulRequests.map(r => r.result),
          errors: failedRequests.map(r => ({
            mediaId: r.item.mediaId,
            mediaType: r.item.mediaType,
            error: r.error?.message || r.result?.error || 'Unknown error',
          })),
        };
      }
    }

    const response: any = {
      summary: {
        total: titles.length,
        pass: passCount,
        blocked: blockedCount,
        actionable: actionableCount,
        passRate: `${((passCount / titles.length) * 100).toFixed(1)}%`,
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

    // Validate first if requested
    if (validateFirst) {
      const detailsCacheKey = { mediaType, mediaId };
      let details = this.cache.get<MediaDetails>('mediaDetails', detailsCacheKey);
      
      if (!details) {
        const response = await this.axiosInstance.get<MediaDetails>(
          `/${mediaType}/${mediaId}`
        );
        details = response.data;
        this.cache.set('mediaDetails', detailsCacheKey, details);
      }

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

      if (mediaInfo?.status === 5) { // AVAILABLE
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

    // Multi-season confirmation check
    if (mediaType === 'tv' && !confirmed) {
      const requireConfirm = process.env.REQUIRE_MULTI_SEASON_CONFIRM !== 'false';
      
      if (requireConfirm && seasons) {
        // Get details to calculate episode count
        const response = await this.axiosInstance.get<MediaDetails>(`/tv/${mediaId}`);
        const details = response.data;

        const totalSeasons = details.numberOfSeasons || 0;
        const seasonsToRequest = seasons === 'all' 
          ? Array.from({ length: totalSeasons }, (_, i) => i + 1)
          : seasons as number[];

        // Calculate total episode count for requested seasons
        let totalEpisodes = 0;
        if (details.seasons) {
          seasonsToRequest.forEach(seasonNum => {
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

    // Dry run - don't actually request
    if (dryRun) {
      const response = await this.axiosInstance.get<MediaDetails>(
        `/${mediaType}/${mediaId}`
      );
      const details = response.data;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              dryRun: true,
              wouldRequest: {
                title: details.title || details.name,
                mediaType,
                mediaId,
                seasons: mediaType === 'tv' ? seasons : undefined,
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

    if (mediaType === 'tv' && seasons) {
      requestBody.seasons = seasons === 'all' ? 'all' : seasons;
    }

    if (args.serverId) requestBody.serverId = args.serverId;
    if (args.profileId) requestBody.profileId = args.profileId;
    if (args.rootFolder) requestBody.rootFolder = args.rootFolder;

    const response = await withRetry(async () => {
      return await this.axiosInstance.post('/request', requestBody);
    });

    // Invalidate caches
    this.cache.invalidate('requests');
    this.cache.invalidate('mediaDetails');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            requestId: response.data.id,
            status: this.getStatusString(response.data.status),
            message: `Successfully requested ${response.data.media.title || response.data.media.name}`,
            seasonsRequested: response.data.seasons?.map((s: any) => s.seasonNumber),
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

    const cacheKey = { requestId: args.requestId };
    let request = this.cache.get<MediaRequest>('requests', cacheKey);

    if (!request) {
      const response = await this.axiosInstance.get<MediaRequest>(
        `/request/${args.requestId}`
      );
      request = response.data;
      this.cache.set('requests', cacheKey, request);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            args.format === 'full' ? request : this.formatCompactRequest(request),
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleListRequests(args: ManageRequestsArgs) {
    const { filter, take, skip, sort, summary } = args;

    // If summary mode, fetch all results (don't use pagination)
    if (summary) {
      const params: any = {
        take: 1000, // Fetch large batch to get all/most results
        skip: 0,
        sort: sort || 'added',
      };

      if (filter && filter !== 'all') {
        params.filter = filter;
      }

      // Don't cache summary queries as they need fresh data
      const response = await this.axiosInstance.get('/requests', { params });
      const requests = response.data;

      const statusCounts: Record<string, number> = {};
      requests.results.forEach((r: MediaRequest) => {
        const status = this.getStatusString(r.status);
        statusCounts[status] = (statusCounts[status] || 0) + 1;
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              total: requests.results.length,
              statusBreakdown: statusCounts,
              filter: filter || 'all',
            }, null, 2),
          },
        ],
      };
    }

    // Regular list mode - use pagination
    const cacheKey = { filter, take, skip, sort };
    let requests = this.cache.get<{ results: MediaRequest[]; PageInfo: any }>('requests', cacheKey);

    if (!requests) {
      const params: any = {
        take: take || 20,
        skip: skip || 0,
        sort: sort || 'added',
      };

      if (filter && filter !== 'all') {
        params.filter = filter;
      }

      const response = await this.axiosInstance.get('/requests', { params });
      requests = response.data;
      this.cache.set('requests', cacheKey, requests);
    }

    const formatted = requests ? requests.results.map(r =>
      args.format === 'full' ? r : this.formatCompactRequest(r)
    ) : [];

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: formatted,
            pageInfo: requests?.PageInfo,
          }, null, 2),
        },
      ],
    };
  }

  private async handleApproveRequests(args: ManageRequestsArgs) {
    const ids = args.requestIds || (args.requestId ? [args.requestId] : []);
    if (ids.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'requestId or requestIds required for approve'
      );
    }

    const results = await batchWithRetry(ids, async (id) => {
      await this.axiosInstance.post(`/request/${id}/approve`);
      return { id, status: 'APPROVED' };
    });

    this.cache.invalidate('requests');

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary: {
              total: ids.length,
              approved: successful.length,
              failed: failed.length,
            },
            results: successful.map(r => r.result),
            errors: failed.map(r => ({ id: r.item, error: r.error?.message })),
          }, null, 2),
        },
      ],
    };
  }

  private async handleDeclineRequests(args: ManageRequestsArgs) {
    const ids = args.requestIds || (args.requestId ? [args.requestId] : []);
    if (ids.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'requestId or requestIds required for decline'
      );
    }

    const results = await batchWithRetry(ids, async (id) => {
      await this.axiosInstance.post(`/request/${id}/decline`);
      return { id, status: 'DECLINED' };
    });

    this.cache.invalidate('requests');

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary: {
              total: ids.length,
              declined: successful.length,
              failed: failed.length,
            },
            results: successful.map(r => r.result),
            errors: failed.map(r => ({ id: r.item, error: r.error?.message })),
          }, null, 2),
        },
      ],
    };
  }

  private async handleDeleteRequests(args: ManageRequestsArgs) {
    const ids = args.requestIds || (args.requestId ? [args.requestId] : []);
    if (ids.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'requestId or requestIds required for delete'
      );
    }

    const results = await batchWithRetry(ids, async (id) => {
      await this.axiosInstance.delete(`/request/${id}`);
      return { id, deleted: true };
    });

    this.cache.invalidate('requests');

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary: {
              total: ids.length,
              deleted: successful.length,
              failed: failed.length,
            },
            results: successful.map(r => r.result),
            errors: failed.map(r => ({ id: r.item, error: r.error?.message })),
          }, null, 2),
        },
      ],
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

    const cacheKey = { mediaType, mediaId, language: language || 'en' };
    let details = this.cache.get<MediaDetails>('mediaDetails', cacheKey);

    if (!details) {
      const params = language ? { language } : {};
      const response = await this.axiosInstance.get<MediaDetails>(
        `/${mediaType}/${mediaId}`,
        { params }
      );
      details = response.data;
      this.cache.set('mediaDetails', cacheKey, details);
    }

    // Apply level filtering
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
        const cacheKey = { 
          mediaType: item.mediaType, 
          mediaId: item.mediaId,
          language: args.language || 'en'
        };
        let details = this.cache.get<MediaDetails>('mediaDetails', cacheKey);
        if (!details) {
          const response = await this.axiosInstance.get<MediaDetails>(
            `/${item.mediaType}/${item.mediaId}`,
            { params: args.language ? { language: args.language } : {} }
          );
          details = response.data;
          this.cache.set('mediaDetails', cacheKey, details);
        }

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

  private formatCompactResult(item: any, mediaInfo?: MediaInfo): CompactMediaResult {
    let status = 'NOT_REQUESTED';
    
    if (mediaInfo) {
      if (mediaInfo.status === 5) {
        status = 'AVAILABLE';
      } else if (mediaInfo.requests && mediaInfo.requests.length > 0) {
        const latestRequest = mediaInfo.requests[0];
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
    console.error('Overseerr MCP server v1.2.1 running on stdio');
  }

  async runHttp(port: number = 8085) {
    const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
    const express = (await import('express')).default;

    const app = express();

    app.get('/health', (_req: any, res: any) => {
      res.json({ status: 'ok', service: 'overseerr-mcp', version: '1.2.1' });
    });

    app.get('/cache/stats', (_req: any, res: any) => {
      res.json(this.cache.getStats());
    });

    app.post('/mcp', async (req: any, res: any) => {
      console.error('New MCP connection established');
      const transport = new SSEServerTransport('/message', res);
      await this.server.connect(transport);

      req.on('close', () => {
        console.error('MCP connection closed');
      });
    });

    app.listen(port, () => {
      console.error(`Overseerr MCP server v1.2.1 running on HTTP port ${port}`);
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
