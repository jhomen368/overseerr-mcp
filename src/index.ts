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

const OVERSEERR_URL = process.env.OVERSEERR_URL;
const OVERSEERR_API_KEY = process.env.OVERSEERR_API_KEY;

if (!OVERSEERR_URL || !OVERSEERR_API_KEY) {
  throw new Error(
    'OVERSEERR_URL and OVERSEERR_API_KEY environment variables are required'
  );
}

interface SearchResult {
  page: number;
  totalPages: number;
  totalResults: number;
  results: Array<{
    id: number;
    mediaType: string;
    title?: string;
    name?: string;
    overview: string;
    posterPath?: string;
    releaseDate?: string;
    firstAirDate?: string;
    voteAverage?: number;
  }>;
}

interface MediaRequest {
  id: number;
  status: number;
  media: {
    id: number;
    tmdbId: number;
    status: number;
  };
  createdAt: string;
  updatedAt: string;
  requestedBy: {
    id: number;
    displayName?: string;
    email: string;
  };
}

interface RequestBody {
  mediaType: 'movie' | 'tv';
  mediaId: number;
  seasons?: number[] | 'all';
  is4k?: boolean;
  serverId?: number;
  profileId?: number;
  rootFolder?: string;
}

const isValidSearchArgs = (
  args: any
): args is { query: string; page?: number; language?: string } =>
  typeof args === 'object' &&
  args !== null &&
  typeof args.query === 'string' &&
  (args.page === undefined || typeof args.page === 'number') &&
  (args.language === undefined || typeof args.language === 'string');

const isValidRequestArgs = (args: any): args is RequestBody =>
  typeof args === 'object' &&
  args !== null &&
  (args.mediaType === 'movie' || args.mediaType === 'tv') &&
  typeof args.mediaId === 'number';

const isValidGetRequestArgs = (
  args: any
): args is { requestId: number } =>
  typeof args === 'object' &&
  args !== null &&
  typeof args.requestId === 'number';

const isValidListRequestsArgs = (
  args: any
): args is { take?: number; skip?: number; filter?: string; sort?: string } =>
  typeof args === 'object' && args !== null;

const isValidUpdateRequestArgs = (
  args: any
): args is { requestId: number; status: 'approve' | 'decline' } =>
  typeof args === 'object' &&
  args !== null &&
  typeof args.requestId === 'number' &&
  (args.status === 'approve' || args.status === 'decline');

const isValidMediaDetailsArgs = (
  args: any
): args is { mediaType: 'movie' | 'tv'; mediaId: number; language?: string } =>
  typeof args === 'object' &&
  args !== null &&
  (args.mediaType === 'movie' || args.mediaType === 'tv') &&
  typeof args.mediaId === 'number';

class OverseerrServer {
  private server: Server;
  private axiosInstance: AxiosInstance;

  constructor() {
    this.server = new Server(
      {
        name: 'overseerr-mcp',
        version: '1.0.0',
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

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'search_media',
          description:
            'Search for movies, TV shows, or people in Overseerr. Returns search results with media details.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query (movie/TV show/person name)',
              },
              page: {
                type: 'number',
                description: 'Page number for pagination (default: 1)',
                default: 1,
              },
              language: {
                type: 'string',
                description: 'Language code (e.g., "en", default: "en")',
                default: 'en',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'request_media',
          description:
            'Request a movie or TV show in Overseerr. For TV shows, you can request specific seasons or all seasons.',
          inputSchema: {
            type: 'object',
            properties: {
              mediaType: {
                type: 'string',
                enum: ['movie', 'tv'],
                description: 'Type of media to request',
              },
              mediaId: {
                type: 'number',
                description: 'TMDB ID of the media',
              },
              seasons: {
                description:
                  'For TV shows: array of season numbers or "all" (optional)',
                oneOf: [
                  {
                    type: 'array',
                    items: { type: 'number' },
                  },
                  {
                    type: 'string',
                    enum: ['all'],
                  },
                ],
              },
              is4k: {
                type: 'boolean',
                description: 'Request 4K version (default: false)',
                default: false,
              },
              serverId: {
                type: 'number',
                description: 'Specific server ID (optional)',
              },
              profileId: {
                type: 'number',
                description: 'Quality profile ID (optional)',
              },
              rootFolder: {
                type: 'string',
                description: 'Root folder path (optional)',
              },
            },
            required: ['mediaType', 'mediaId'],
          },
        },
        {
          name: 'get_request',
          description:
            'Get details of a specific media request by request ID.',
          inputSchema: {
            type: 'object',
            properties: {
              requestId: {
                type: 'number',
                description: 'Request ID',
              },
            },
            required: ['requestId'],
          },
        },
        {
          name: 'list_requests',
          description:
            'List media requests with optional filtering and pagination. Returns all requests if user has admin permissions, otherwise only returns user\'s own requests.',
          inputSchema: {
            type: 'object',
            properties: {
              take: {
                type: 'number',
                description: 'Number of results to return (default: 20)',
                default: 20,
              },
              skip: {
                type: 'number',
                description: 'Number of results to skip (default: 0)',
                default: 0,
              },
              filter: {
                type: 'string',
                enum: [
                  'all',
                  'approved',
                  'available',
                  'pending',
                  'processing',
                  'unavailable',
                  'failed',
                ],
                description: 'Filter requests by status (default: "all")',
                default: 'all',
              },
              sort: {
                type: 'string',
                enum: ['added', 'modified'],
                description: 'Sort order (default: "added")',
                default: 'added',
              },
            },
          },
        },
        {
          name: 'update_request_status',
          description:
            'Approve or decline a media request. Requires MANAGE_REQUESTS permission or ADMIN.',
          inputSchema: {
            type: 'object',
            properties: {
              requestId: {
                type: 'number',
                description: 'Request ID',
              },
              status: {
                type: 'string',
                enum: ['approve', 'decline'],
                description: 'New status for the request',
              },
            },
            required: ['requestId', 'status'],
          },
        },
        {
          name: 'get_media_details',
          description:
            'Get detailed information about a movie or TV show from TMDB.',
          inputSchema: {
            type: 'object',
            properties: {
              mediaType: {
                type: 'string',
                enum: ['movie', 'tv'],
                description: 'Type of media',
              },
              mediaId: {
                type: 'number',
                description: 'TMDB ID of the media',
              },
              language: {
                type: 'string',
                description: 'Language code (default: "en")',
                default: 'en',
              },
            },
            required: ['mediaType', 'mediaId'],
          },
        },
        {
          name: 'delete_request',
          description:
            'Delete a media request. Users can delete their own pending requests, or any request with MANAGE_REQUESTS permission.',
          inputSchema: {
            type: 'object',
            properties: {
              requestId: {
                type: 'number',
                description: 'Request ID to delete',
              },
            },
            required: ['requestId'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case 'search_media':
            return await this.handleSearchMedia(request.params.arguments);
          case 'request_media':
            return await this.handleRequestMedia(request.params.arguments);
          case 'get_request':
            return await this.handleGetRequest(request.params.arguments);
          case 'list_requests':
            return await this.handleListRequests(request.params.arguments);
          case 'update_request_status':
            return await this.handleUpdateRequestStatus(
              request.params.arguments
            );
          case 'get_media_details':
            return await this.handleGetMediaDetails(request.params.arguments);
          case 'delete_request':
            return await this.handleDeleteRequest(request.params.arguments);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const message = error.response?.data?.message || error.message;
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

  private async handleSearchMedia(args: any) {
    if (!isValidSearchArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid search arguments');
    }

    const response = await this.axiosInstance.get<SearchResult>('/search', {
      params: {
        query: args.query,
        page: args.page || 1,
        language: args.language || 'en',
      },
    });

    const results = response.data.results.map((item) => ({
      id: item.id,
      type: item.mediaType,
      title: item.title || item.name || 'Unknown',
      overview: item.overview || 'No overview available',
      releaseDate: item.releaseDate || item.firstAirDate || 'Unknown',
      rating: item.voteAverage || 'N/A',
      posterPath: item.posterPath
        ? `https://image.tmdb.org/t/p/w500${item.posterPath}`
        : null,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              page: response.data.page,
              totalPages: response.data.totalPages,
              totalResults: response.data.totalResults,
              results,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleRequestMedia(args: any) {
    if (!isValidRequestArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid request arguments');
    }

    const requestBody: RequestBody = {
      mediaType: args.mediaType,
      mediaId: args.mediaId,
    };

    if (args.seasons !== undefined) {
      requestBody.seasons = args.seasons;
    }
    if (args.is4k !== undefined) {
      requestBody.is4k = args.is4k;
    }
    if (args.serverId !== undefined) {
      requestBody.serverId = args.serverId;
    }
    if (args.profileId !== undefined) {
      requestBody.profileId = args.profileId;
    }
    if (args.rootFolder !== undefined) {
      requestBody.rootFolder = args.rootFolder;
    }

    const response = await this.axiosInstance.post<MediaRequest>(
      '/request',
      requestBody
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              requestId: response.data.id,
              status: this.getStatusString(response.data.status),
              message: 'Media request created successfully',
              details: response.data,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleGetRequest(args: any) {
    if (!isValidGetRequestArgs(args)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Invalid get request arguments'
      );
    }

    const response = await this.axiosInstance.get<MediaRequest>(
      `/request/${args.requestId}`
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              requestId: response.data.id,
              status: this.getStatusString(response.data.status),
              mediaStatus: this.getMediaStatusString(
                response.data.media.status
              ),
              requestedBy: response.data.requestedBy.email,
              createdAt: response.data.createdAt,
              updatedAt: response.data.updatedAt,
              details: response.data,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleListRequests(args: any) {
    if (!isValidListRequestsArgs(args)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Invalid list requests arguments'
      );
    }

    const response = await this.axiosInstance.get<{
      pageInfo: { pages: number; pageSize: number; results: number };
      results: MediaRequest[];
    }>('/request', {
      params: {
        take: args.take || 20,
        skip: args.skip || 0,
        filter: args.filter || 'all',
        sort: args.sort || 'added',
      },
    });

    const requests = response.data.results.map((req) => ({
      requestId: req.id,
      status: this.getStatusString(req.status),
      mediaStatus: this.getMediaStatusString(req.media.status),
      requestedBy: req.requestedBy.email,
      createdAt: req.createdAt,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              pageInfo: response.data.pageInfo,
              requests,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleUpdateRequestStatus(args: any) {
    if (!isValidUpdateRequestArgs(args)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Invalid update request arguments'
      );
    }

    const response = await this.axiosInstance.post<MediaRequest>(
      `/request/${args.requestId}/${args.status}`
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              requestId: response.data.id,
              newStatus: this.getStatusString(response.data.status),
              message: `Request ${args.status}d successfully`,
              details: response.data,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleGetMediaDetails(args: any) {
    if (!isValidMediaDetailsArgs(args)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Invalid media details arguments'
      );
    }

    const endpoint = args.mediaType === 'movie' ? 'movie' : 'tv';
    const response = await this.axiosInstance.get(
      `/${endpoint}/${args.mediaId}`,
      {
        params: {
          language: args.language || 'en',
        },
      }
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async handleDeleteRequest(args: any) {
    if (!isValidGetRequestArgs(args)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Invalid delete request arguments'
      );
    }

    await this.axiosInstance.delete(`/request/${args.requestId}`);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              message: 'Request deleted successfully',
              requestId: args.requestId,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private getStatusString(status: number): string {
    const statusMap: { [key: number]: string } = {
      1: 'PENDING_APPROVAL',
      2: 'APPROVED',
      3: 'DECLINED',
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
    console.error('Overseerr MCP server running on stdio');
  }

  async runHttp(port: number = 8085) {
    const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
    const express = (await import('express')).default;
    
    const app = express();
    
    app.get('/health', (_req, res) => {
      res.json({ status: 'ok', service: 'overseerr-mcp' });
    });

    app.post('/mcp', async (req, res) => {
      console.error('New MCP connection established');
      const transport = new SSEServerTransport('/message', res);
      await this.server.connect(transport);
      
      req.on('close', () => {
        console.error('MCP connection closed');
      });
    });

    app.listen(port, () => {
      console.error(`Overseerr MCP server running on HTTP port ${port}`);
      console.error(`MCP endpoint: http://localhost:${port}/mcp`);
      console.error(`Health check: http://localhost:${port}/health`);
    });
  }
}

const server = new OverseerrServer();

// Check if running in HTTP mode (via environment variable or command line arg)
const httpMode = process.env.HTTP_MODE === 'true' || process.argv.includes('--http');
const port = process.env.PORT ? parseInt(process.env.PORT) : 8085;

if (httpMode) {
  server.runHttp(port).catch(console.error);
} else {
  server.run().catch(console.error);
}
