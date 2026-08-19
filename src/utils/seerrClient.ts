import axios, { AxiosInstance } from 'axios';
import { withRetry } from './retry.js';
import { CacheManager } from './cache.js';
import { encodeSearchQuery } from './normalize.js';
import type {
  SearchResult,
  MediaDetails,
  MediaRequest,
  ServiceConfig,
  ServiceDetailsResponse,
} from '../types.js';

export interface CreateRequestBody {
  mediaType: 'movie' | 'tv';
  mediaId: number;
  is4k?: boolean;
  seasons?: number[];
  serverId?: number;
  profileId?: number;
  rootFolder?: string;
}

export interface ListRequestsParams {
  filter?: string;
  take?: number;
  skip?: number;
  sort?: string;
}

export interface CreatedRequest {
  id: number;
  status: number;
  seasons?: Array<{ seasonNumber: number; status: number }>;
}

/**
 * Typed client for the Seerr API.
 *
 * Hides all HTTP, cache, and retry concerns from the tool handlers.
 * Read-only GET methods apply withRetry internally; mutation methods
 * (POST/DELETE) are intentionally not retried to avoid replaying
 * non-idempotent operations on transient failures.
 * Cache key construction and invalidation are a single responsibility
 * of this module.
 *
 * mediaDetails cache keys always include language (default 'en') for
 * consistency — previous callers were split between keying with and
 * without language, which prevented cache sharing.
 */
export class SeerrApiClient {
  private readonly http: AxiosInstance;
  private readonly cache: CacheManager;

  constructor(url: string, apiKey: string, cache?: CacheManager) {
    this.http = axios.create({
      baseURL: `${url}/api/v1`,
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    });
    this.cache = cache ?? new CacheManager();
  }

  /** Expose cache for stats endpoint and health checks. */
  getCache(): CacheManager {
    return this.cache;
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  async search(
    query: string,
    options?: { page?: number; language?: string }
  ): Promise<SearchResult> {
    const page = options?.page ?? 1;
    const language = options?.language ?? 'en';
    const cacheKey = { query, page, language };

    const cached = this.cache.get<SearchResult>('search', cacheKey);
    if (cached) return cached;

    const encodedQuery = encodeSearchQuery(query);
    const response = await withRetry(() =>
      this.http.get<SearchResult>(
        `/search?query=${encodedQuery}&page=${page}&language=${encodeURIComponent(language)}`
      )
    );
    this.cache.set('search', cacheKey, response.data);
    return response.data;
  }

  // ── Media details ────────────────────────────────────────────────────────────

  async getMediaDetails(
    type: 'movie' | 'tv',
    id: number,
    options?: { language?: string }
  ): Promise<MediaDetails> {
    const language = options?.language ?? 'en';
    const cacheKey = { mediaType: type, mediaId: id, language };

    const cached = this.cache.get<MediaDetails>('mediaDetails', cacheKey);
    if (cached) return cached;

    const params = language !== 'en' ? { params: { language } } : {};
    const response = await withRetry(() =>
      this.http.get<MediaDetails>(`/${type}/${id}`, params)
    );
    this.cache.set('mediaDetails', cacheKey, response.data);
    return response.data;
  }

  // ── Requests ─────────────────────────────────────────────────────────────────

  async createRequest(body: CreateRequestBody): Promise<CreatedRequest> {
    const response = await this.http.post<CreatedRequest>('/request', body);
    this.cache.invalidate('requests');
    this.cache.invalidate('mediaDetails');
    return response.data;
  }

  async getRequest(id: number): Promise<MediaRequest> {
    const cacheKey = { requestId: id };

    const cached = this.cache.get<MediaRequest>('requests', cacheKey);
    if (cached) return cached;

    const response = await withRetry(() =>
      this.http.get<MediaRequest>(`/request/${id}`)
    );
    this.cache.set('requests', cacheKey, response.data);
    return response.data;
  }

  async listRequests(
    params: ListRequestsParams
  ): Promise<{ results: MediaRequest[]; pageInfo: any }> {
    const { filter, take = 20, skip = 0, sort = 'added' } = params;
    const cacheKey = { filter: filter ?? 'all', take, skip, sort };

    const cached = this.cache.get<{ results: MediaRequest[]; pageInfo: any }>(
      'requests',
      cacheKey
    );
    if (cached) return cached;

    const queryParams: Record<string, any> = { take, skip, sort };
    if (filter && filter !== 'all') queryParams.filter = filter;

    const response = await withRetry(() =>
      this.http.get<{ results: MediaRequest[]; pageInfo: any }>(
        '/request',
        { params: queryParams }
      )
    );
    this.cache.set('requests', cacheKey, response.data);
    return response.data;
  }

  /**
   * Fetches all requests (up to 1000) without caching.
   * Used for building status count summaries.
   */
  async listAllRequests(params?: {
    filter?: string;
    sort?: string;
  }): Promise<{ results: MediaRequest[] }> {
    const queryParams: Record<string, any> = {
      take: 1000,
      skip: 0,
      sort: params?.sort ?? 'added',
    };
    if (params?.filter && params.filter !== 'all') queryParams.filter = params.filter;

    const response = await withRetry(() =>
      this.http.get<{ results: MediaRequest[] }>(
        '/request',
        { params: queryParams }
      )
    );
    return response.data;
  }

  async approveRequest(id: number): Promise<void> {
    await this.http.post(`/request/${id}/approve`);
    this.cache.invalidate('requests');
    this.cache.invalidate('mediaDetails');
  }

  async declineRequest(id: number): Promise<void> {
    await this.http.post(`/request/${id}/decline`);
    this.cache.invalidate('requests');
    this.cache.invalidate('mediaDetails');
  }

  async deleteRequest(id: number): Promise<void> {
    await this.http.delete(`/request/${id}`);
    this.cache.invalidate('requests');
    this.cache.invalidate('mediaDetails');
  }

  // ── Services ─────────────────────────────────────────────────────────────────

  async listServices(type: 'radarr' | 'sonarr'): Promise<ServiceConfig[]> {
    const cacheKey = { serviceType: type };

    const cached = this.cache.get<ServiceConfig[]>('services', cacheKey);
    if (cached) return cached;

    const response = await withRetry(() =>
      this.http.get<ServiceConfig[]>(`/service/${type}`)
    );
    this.cache.set('services', cacheKey, response.data);
    return response.data;
  }

  async getServiceDetails(
    type: 'radarr' | 'sonarr',
    serverId = 0
  ): Promise<ServiceDetailsResponse> {
    const cacheKey = { serviceType: type, serverId };

    const cached = this.cache.get<ServiceDetailsResponse>('serviceDetails', cacheKey);
    if (cached) return cached;

    const response = await withRetry(() =>
      this.http.get<ServiceDetailsResponse>(`/service/${type}/${serverId}`)
    );
    this.cache.set('serviceDetails', cacheKey, response.data);
    return response.data;
  }

  // ── Cache control ─────────────────────────────────────────────────────────────

  invalidate(type?: 'search' | 'mediaDetails' | 'requests' | 'services' | 'serviceDetails'): void {
    this.cache.invalidate(type);
  }
}
