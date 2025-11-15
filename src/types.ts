// Overseerr API response types
export interface SearchResult {
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

export interface MediaRequest {
  id: number;
  status: number;
  media: {
    id: number;
    tmdbId: number;
    status: number;
    seasons?: Array<{
      seasonNumber: number;
      status: number;
    }>;
  };
  createdAt: string;
  updatedAt: string;
  requestedBy: {
    id: number;
    displayName?: string;
    email: string;
  };
}

export interface MediaInfo {
  id: number;
  tmdbId: number;
  status: number;
  requests?: MediaRequest[];
  seasons?: Array<{
    id: number;
    seasonNumber: number;
    status: number;
    createdAt: string;
    updatedAt: string;
  }>;
}

export interface MediaDetails {
  id: number;
  mediaType?: string;  // Add mediaType for enrichment
  title?: string;
  name?: string;
  overview?: string;
  releaseDate?: string;
  firstAirDate?: string;
  posterPath?: string;  // Add posterPath
  backdropPath?: string;  // Add backdropPath
  genres?: Array<{ id: number; name: string }>;
  voteAverage?: number;
  runtime?: number;
  numberOfSeasons?: number;
  numberOfEpisodes?: number;
  seasons?: Array<{
    seasonNumber: number;
    episodeCount: number;
    airDate?: string;
  }>;
  // Advanced fields
  originalTitle?: string;
  originalName?: string;
  popularity?: number;
  homepage?: string;
  status?: string;
  tagline?: string;
  mediaInfo?: MediaInfo;
}

// Tool input types
export interface SearchMediaArgs {
  query?: string;
  queries?: string[];
  dedupeMode?: boolean;
  titles?: string[];
  autoNormalize?: boolean;
  autoRequest?: boolean;
  requestOptions?: {
    seasons?: number[] | 'all';
    is4k?: boolean;
    serverId?: number;
    profileId?: number;
    rootFolder?: string;
    dryRun?: boolean;
  };
  checkAvailability?: boolean;
  format?: 'compact' | 'standard' | 'full';
  limit?: number;
  page?: number;
  language?: string;
  // NEW: Optional details enrichment for dedupe mode
  includeDetails?: {
    fields?: string[];  // Array of field names to include
    includeSeason?: boolean;  // Auto-include season info for TV shows (default: true)
  };
}

export interface RequestMediaArgs {
  mediaType?: 'movie' | 'tv';
  mediaId?: number;
  items?: Array<{
    mediaType: 'movie' | 'tv';
    mediaId: number;
    seasons?: number[] | 'all';
    is4k?: boolean;
  }>;
  seasons?: number[] | 'all';
  is4k?: boolean;
  serverId?: number;
  profileId?: number;
  rootFolder?: string;
  validateFirst?: boolean;
  dryRun?: boolean;
  confirmed?: boolean;
}

export interface ManageRequestsArgs {
  action: 'get' | 'list' | 'approve' | 'decline' | 'delete';
  requestId?: number;
  requestIds?: number[];
  format?: 'compact' | 'standard' | 'full';
  summary?: boolean;
  filter?: 'all' | 'pending' | 'approved' | 'available' | 'processing' | 'unavailable' | 'failed';
  take?: number;
  skip?: number;
  sort?: 'added' | 'modified';
}

export interface GetDetailsArgs {
  mediaType?: 'movie' | 'tv';
  mediaId?: number;
  items?: Array<{
    mediaType: 'movie' | 'tv';
    mediaId: number;
  }>;
  level?: 'basic' | 'standard' | 'full';
  fields?: string[];
  format?: 'compact' | 'standard' | 'full';
  language?: string;
}

// Tool output types
export interface DedupeResult {
  title: string;
  id: number;
  mediaType?: 'movie' | 'tv';  // Added to track type for autoRequest
  status: 'pass' | 'blocked';
  reasonCode: 'NOT_FOUND' | 'ALREADY_AVAILABLE' | 'ALREADY_REQUESTED' | 'SEASON_AVAILABLE' | 'SEASON_REQUESTED' | 'AVAILABLE_FOR_REQUEST';
  isActionable: boolean;
  reason?: string;
  franchiseInfo?: string;
  note?: string;
  requestedSeason?: number | null;
  details?: DedupeDetails;
}

// NEW: Enriched details type for dedupe results
export interface DedupeDetails {
  // Basic info
  mediaType?: string;
  year?: string;
  posterPath?: string;
  
  // Standard details
  rating?: number;
  overview?: string;
  genres?: Array<{ id: number; name: string }>;
  runtime?: number;
  
  // TV-specific
  numberOfSeasons?: number;
  numberOfEpisodes?: number;
  seasons?: Array<{
    seasonNumber: number;
    episodeCount: number;
    airDate?: string;
    status?: string;  // Availability status
  }>;
  
  // Season-specific enrichment (auto-added for season titles)
  targetSeason?: {
    seasonNumber: number;
    episodeCount: number;
    airDate?: string;
    status: string;
  };
  
  // Advanced
  releaseDate?: string;
  firstAirDate?: string;
  originalTitle?: string;
  originalName?: string;
  popularity?: number;
  backdropPath?: string;
  homepage?: string;
  status?: string;
  tagline?: string;
  
  // Availability (from mediaInfo)
  mediaStatus?: number;
  hasRequests?: boolean;
  requestCount?: number;
}

export interface CompactMediaResult {
  id: number;
  type: string;
  title: string;
  year?: string;
  rating?: number;
  status?: string;
}

export interface RequestResult {
  success: boolean;
  requestId?: number;
  title?: string;
  status?: string;
  message: string;
  seasonsRequested?: number[];
}

export interface MultiSeasonConfirmation {
  requiresConfirmation: true;
  media: {
    title: string;
    totalSeasons: number;
    totalEpisodes?: number;
    requestingSeasons: number[] | 'all';
  };
  message: string;
  confirmWith: RequestMediaArgs;
}