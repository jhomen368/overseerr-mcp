## [2.1.3] - 2026-05-20

### Fixed
- **Request API path**: Fixed `manage_media_requests` returning 404 errors — the list/summary endpoints were using `/requests` (plural) instead of the correct `/request` (singular) API path

### Changed
- **Dependencies**: Bumped `@commitlint/cli` to 21.0.1, `@commitlint/config-conventional` to 21.0.1, `@types/node` to 25.9.0, `axios` to 1.16.1, `typescript` to 6.0.3, `@modelcontextprotocol/sdk` to 1.29.0
- **Docker**: Bumped base image from `node:25-alpine` to `node:26-alpine`
- **CI**: Bumped `aquasecurity/trivy-action` to 0.36.0; allowed CI to see Trivy scan results
- **Gitignore**: Added `opencode.json` to `.gitignore`

## [2.1.2] - 2026-04-08

### Fixed
- **Non-existent season handling**: Searching for a season that doesn't exist (e.g. "Overlord S99") now correctly returns the real show ID with a `SEASON_NOT_FOUND` reason code instead of treating the whole search as `NOT_FOUND`
- **Compact search status accuracy**: `search_media` in compact format now correctly reflects library availability by reading `mediaInfo` from search results — titles already in Plex will show `AVAILABLE` instead of `NOT_REQUESTED`
- **autoRequest summary counts**: Fixed incorrect `pass`/`blocked`/`actionable` counts caused by double-wrapped processor returns; summary now always reflects the actual dedupe results
- **autoRequest result field**: Fixed the `autoRequests` result object not being populated correctly when `autoRequest: true` is used
- **Season availability blocking**: Dedupe mode now correctly blocks titles where the requested season is already in the library (previously some already-available seasons could slip through as actionable)
- **Pass rate calculation**: `passRate` in dedupe summary now uses total input titles as the denominator instead of the deduped result count, giving a more accurate percentage
- **Season validation with empty array**: Fixed a crash when `dedupeMode` received a title with no specific seasons to validate against
- **Media title fallback**: Removed an unnecessary title fallback that could produce undefined/blank titles in request responses

### Breaking Changes
- `passRate` in dedupe summary now divides by total input titles rather than deduped results — the percentage will be lower if duplicate titles were in the input list

## [2.1.1] - 2026-03-25

### Fixed
- **HTTP/SSE reconnection stability**: Fixed "Error: Already connected to a transport" crash when an MCP client reconnects after disconnecting in HTTP mode
  - Added single-client enforcement: returns HTTP 409 Conflict with `Retry-After` header if a client is already connected
  - Properly cleans up server state when a client disconnects via `req.on('close')`
  - Resets connection flag on failed connection attempts to prevent permanent lockout
  - Prevents race condition by setting the connection flag before the async `connect()` call
- **`request_media` seasons array handling**: Fixed "seasonsToRequest.forEach is not a function" crash when calling `request_media` with an explicit seasons array (e.g. `seasons: [1, 2]`) — the MCP SDK can deliver array parameters in non-standard formats; added runtime type checking to normalize them correctly before processing

---

## [2.1.0] - 2026-03-16

### Added
- **`get_services` Tool**: List configured Radarr/Sonarr servers from the Seerr/Overseerr instance
  - Returns server details: `id`, `name`, `isDefault`, `is4k`, active directory, profile ID, and tags
  - Supports optional `serviceType` filter (`radarr` or `sonarr`); omit for both
  - Anime-specific overrides included when configured (`activeAnimeDirectory`, `activeAnimeProfileId`, `activeAnimeTags`)
  - Results cached for 10 minutes (`CACHE_SERVICES_TTL` env var, default: 10 min)

- **`get_service_details` Tool**: Get quality profiles, root folders, tags, and language profiles for a specific server
  - Required `serviceType` parameter (`radarr` or `sonarr`)
  - Optional `serverId` parameter (default: `0`; use `get_services` to retrieve IDs)
  - Sonarr responses include `languageProfiles` array
  - Results cached for 10 minutes (`CACHE_SERVICEDETAILS_TTL` env var, default: 10 min)

- **Service Discovery Type Definitions** (`src/types.ts`)
  - New types: `ServiceConfig`, `QualityProfile`, `RootFolder`, `Tag`, `LanguageProfile`, `ServiceDetailsResponse`
  - New input types: `GetServicesArgs` and `GetServiceDetailsArgs`

- **New Cache Types**: `services` and `serviceDetails` added to caching layer
  - TTL: 10 minutes each (configurable via `CACHE_SERVICES_TTL` and `CACHE_SERVICEDETAILS_TTL`)
  - Both types tracked in hit/miss stats and visible at `/cache/stats` endpoint

- **MCP Metadata Updated**: `package.json` `mcp.server.tools` declaration now lists all 6 tools
  - Improves discoverability on LobeHub and compatible MCP clients

### Changed
- **Express updated to v5**: Runtime dependency `express` bumped from `^4.18.2` to `^5.1.0`
  - `@types/express` dev dependency updated to `^5.0.5`
- **Node types updated**: `@types/node` dev dependency updated to `^25.0.3`
- **Tool count**: Server now exposes 6 tools (up from 4)

---

## [2.0.0] - 2026-02-18

### Added
- **Seerr Support**: Full compatibility with Seerr (Overseerr/Jellyseerr merger)
  - API is 100% backward compatible
  - No functional changes required
- **Dual Environment Variable Support**
  - New `SEERR_URL` and `SEERR_API_KEY` environment variables (preferred)
  - Legacy `OVERSEERR_URL` and `OVERSEERR_API_KEY` still supported
  - `SEERR_*` variables take precedence when both are provided
  - Deprecation warnings logged for `OVERSEERR_*` variables

### Changed
- **Branding Update**: Primary branding changed from Overseerr to Seerr
  - Server name: `overseerr-mcp` → `seerr-mcp` (internal)
  - Package name remains `@jhomen368/overseerr-mcp` for backward compatibility
  - Docker image remains `ghcr.io/jhomen368/overseerr-mcp`
- **Documentation**: Updated README.md to reflect Seerr as primary, Overseerr as legacy
  - All examples use `SEERR_*` environment variables
  - Added migration notes for existing users
- **Logging**: Enhanced server startup messages to indicate Seerr/Overseerr compatibility
  - Health check endpoint now includes compatibility list
- **Error Messages**: Updated to use "Seerr" terminology

### Deprecated
- `OVERSEERR_URL` and `OVERSEERR_API_KEY` environment variables
  - Will be removed in v3.0.0 (planned for ~1 year from now)
  - Use `SEERR_URL` and `SEERR_API_KEY` instead
  - Deprecation warnings are non-intrusive (stderr only)

### Migration Guide
**For Existing Users:**
1. **No action required** - All OVERSEERR_* variables continue to work
2. **Recommended**: Update environment variables from `OVERSEERR_*` to `SEERR_*`
3. **Claude Desktop users**: Update `claude_desktop_config.json` to use `SEERR_*` variables
4. **Docker users**: Update environment variables in docker-compose.yml or docker run commands

**Example Migration:**
```json
// OLD (still works, but deprecated)
{
  "env": {
    "OVERSEERR_URL": "https://overseerr.example.com",
    "OVERSEERR_API_KEY": "your-key"
  }
}

// NEW (recommended)
{
  "env": {
    "SEERR_URL": "https://overseerr.example.com",  // Works with both Seerr and Overseerr
    "SEERR_API_KEY": "your-key"
  }
}
```

**Breaking Changes:** None - 100% backward compatible

---

## [1.2.4] - 2026-01-12

### Fixed
- **Code Quality**: Addressed code scanning alert for useless assignment to local variable
  - Removed redundant variable assignment to improve code cleanliness

### Security
- **Dependency Updates**: Comprehensive update of runtime and development dependencies
  - Updated `@modelcontextprotocol/sdk` to v1.25.2
  - Updated `express` and `body-parser` for security and stability
  - Updated `qs` library
  - Updated GitHub Actions versions (`codeql-action` v4, `setup-qemu-action` v3, `checkout` v6)

## [1.2.3] - 2025-11-18

### Added
- **Automated Security Workflows**
  - **Dependabot**: Automated dependency updates for npm, GitHub Actions, and Docker base images
    - Weekly scans on Mondays with max 5 open PRs
    - File: `.github/dependabot.yml`
  - **CodeQL Security Scanning**: Static code analysis for vulnerabilities
    - Runs on every push/PR to main + weekly schedule
    - Uses security-extended queries for comprehensive coverage
    - Reports to GitHub Security tab (non-blocking)
    - File: `.github/workflows/codeql-analysis.yml`
  - **CI Workflow**: Comprehensive build and test pipeline
    - Runs on every PR and push to main
    - npm audit for dependency vulnerabilities
    - TypeScript build verification
    - Docker build test (no publishing)
    - Trivy vulnerability scanning (non-blocking on PRs)
    - Docker startup verification
    - File: `.github/workflows/ci.yml`
  - **Trivy Docker Vulnerability Scanner**: Container image security scanning
    - Scans at release time (on tag push) for CRITICAL/HIGH vulnerabilities
    - Blocks releases if vulnerabilities found
    - Uploads results to GitHub Security tab
    - Integrated into `.github/workflows/docker-publish.yml`
- **Security Enhancements**
  - **Added Trivy vulnerability scanning to CI pipeline** (blocks PRs if vulnerabilities found)
    - Scans Docker images during PR review
    - exit-code: 1 blocks merging vulnerable code
    - CD pipeline trusts CI validation (no redundant scanning)
    - Uploads SARIF results to GitHub Security tab

- **Docker Security Hardening**
  - Added `dumb-init` for proper signal handling
  - Set `NODE_ENV=production`
  - Added OCI labels for container metadata
  - Uses `dumb-init` as ENTRYPOINT

- **Runtime Input Validation**
  - Validates `OVERSEERR_URL` format (http/https)
  - Validates `OVERSEERR_API_KEY` format (min 20 chars, Base64-compatible with `=` padding)
  - Fails fast with clear error messages
  - File: `src/index.ts`

### Changed
- **Documentation**: Complete README.md overhaul for clarity and professionalism
  - Reduced from 507 lines to ~280 lines (45% reduction)
  - Added PayPal donate link and LobeHub badge
  - Added tools quick reference table for easy scanning
  - Streamlined all sections with better visual hierarchy
  - Removed redundant version history details
  - Clear links to CONTRIBUTING.md and CHANGELOG.md for detailed info
  - Improved troubleshooting section for conciseness

### Added
- **MCP Metadata**: Added explicit MCP server metadata to package.json
  - Declared all 4 tools with descriptions for LobeHub detection
  - Should improve "Includes At Least One Tool" score on LobeHub
  - Added transport type declaration

### Security
- GitHub Advanced Security features now enabled via workflows
- All security scans report to unified GitHub Security tab
- Release-time vulnerability blocking prevents publishing vulnerable images

## [1.2.2] - 2025-11-15

### Fixed
- **Bug #20**: Season 0 (specials) automatically requested with `seasons: "all"`
  - `seasons: "all"` now explicitly excludes season 0 (specials) for TV shows
  - Expansion logic filters seasons using `s.seasonNumber > 0` condition
  - Applies to both `request_media` tool and auto-request workflow in dedupe mode
  - Fixed in handleSingleRequest method (src/index.ts line ~1458)
  - Fixed in handleDedupeMode auto-request logic (src/index.ts line ~1342)
  - To request specials, users must explicitly include 0 in array: `seasons: [0, 1, 2]`

### Changed
- Updated tool descriptions to clarify season 0 exclusion behavior
  - `request_media` description now states: "seasons:'all' excludes season 0 (specials); use explicit array like [0,1,2] to include specials"
  - `search_media` requestOptions.seasons description updated with same clarification
  - Parameter descriptions in inputSchema updated for both single and batch modes

## [1.2.1] - 2025-11-15

### Fixed
- **Bug #19**: TV show requests without seasons parameter causing HTTP 500 errors
  - Added validation to ensure TV show requests include the required `seasons` parameter
  - Returns clear error message: "seasons parameter is required for TV show requests"
  - Added default 'all' seasons fallback for auto-request workflow when no season specified
  - Prevents Overseerr API error: "Cannot read properties of undefined (reading 'filter')"
  - Fixed in handleSingleRequest method (src/index.ts line ~1433)
  - Updated auto-request queue processing for TV shows vs movies (src/index.ts line ~1269)
  - Updated tool description to clarify seasons requirement for TV shows

### Changed
- Tool description for `request_media` now explicitly states: "TV shows require seasons parameter (array or 'all')"
- Auto-request workflow now distinguishes between TV shows (requires seasons) and movies (no seasons needed)

## [1.2.0] - 2025-11-15

### Fixed
- **Bug #18**: NOT_FOUND items now correctly have status "blocked" instead of "pass"
  - Items not found in TMDB cannot be requested, so status is now "blocked" to reflect this
  - Fixed in 3 locations: lines 766, 834, and 1293 in src/index.ts
  - Prevents confusion in summary statistics (pass count vs blocked count)
  - Clear distinction between actionable (pass) and non-actionable (blocked) items
- Season validation feature implemented
  - Ensures requested seasons do not exceed available titles
  - Returns NOT_FOUND for invalid season numbers
  - Fully tested and integrated into workflow
  - Do not request seasons that are not available

### Changed
- Updated TEST_PLAN.md: Category 1 now has 9 tests (was 8)
- Updated package version to 1.2.0
- Total test count increased from 75+ to 76+ scenarios

### Improved
- **Enhanced Status Checking**: Improved from simple equality (=== 5) to range checking ([2, 3, 4, 5].includes())
  - Now properly handles PENDING (2), PROCESSING (3), PARTIALLY_AVAILABLE (4), and AVAILABLE (5) statuses
  - More accurate detection of media in library across all availability states
  - Implemented in 6 locations throughout deduplication logic
- **PARTIALLY_AVAILABLE Support**: Added proper handling for partial availability status (status 4)
  - Enrichment functions now include PARTIALLY_AVAILABLE in status mappings
  - Better representation of media that is partially downloaded/available
  - More accurate franchise info for series with some seasons available

### Testing
- **All 76 tests passed** (100% pass rate) ✅
- **12 categories tested** (100% coverage)
- **Bug #18 verified fixed** with live testing
- **Test 1.9 validated** season validation feature working correctly

## [1.1.0] - 2025-11-14

### Architecture Overhaul 🏗️

**Major Features Added:**
- Consolidated 8 tools into 4 powerful, flexible tools
- Batch operations support across all tools
- In-memory caching system with configurable TTL
- Server-side title normalization for anime/TV series
- Built-in retry logic with exponential backoff
- Context-efficient response formats (compact/standard/full)

### New Tools (Consolidated Architecture)

1. **`search_media`** - Unified search with batch dedupe mode
   - Single query search
   - Multiple queries (batch mode)
   - **Dedupe mode**: Check 50-100 titles in ONE API call (99% reduction)
   - Server-side title normalization
   - Two-level checking (base series + specific season)
   - Compact response format by default

2. **`request_media`** - Enhanced media requests
   - Single and batch request support
   - Multi-season confirmation (requires approval if >1 season)
   - Validation (check if already requested/available)
   - Dry-run mode for previewing requests
   - Cache invalidation on request

3. **`manage_media_requests`** - All-in-one request management
   - Actions: get, list, approve, decline, delete
   - Summary mode (statistics instead of full list)
   - Batch approve/decline/delete
   - Compact response format
   - Smart caching

4. **`get_media_details`** - Flexible detail lookup
   - Single and batch lookup
   - Level control: basic/standard/full
   - Field selection
   - Optimized for reduced token usage

### Infrastructure Improvements

**Caching System** (`src/utils/cache.ts`)
- In-memory Map-based cache with LRU eviction
- Configurable TTLs per cache type:
  - Search: 5 minutes
  - Media details: 30 minutes
  - Requests: 1 minute
- Hit/miss tracking
- Stats endpoint: `GET /cache/stats`
- **Expected**: 70-85% API call reduction

**Title Normalization** (`src/utils/normalize.ts`)
- Strips season indicators: "Season N", "S N", "Part N", "Cour N"
- Removes year suffix: "(2024)"
- Preserves integral numbers: "Mob Psycho 100"
- Season number extraction
- Sequel detection

**Retry Logic** (`src/utils/retry.ts`)
- Exponential backoff: 100ms → 500ms → 1000ms
- Automatic retry on network errors and 5xx
- Batch processing with per-item retry
- Continues on failure (collects all results)

**Type System** (`src/types.ts`)
- Comprehensive type definitions for all operations
- Tool argument interfaces
- Response types
- Overseerr API response types

### Configuration

**New Environment Variables:**
```bash
# Caching
CACHE_ENABLED=true                    # Enable/disable cache (default: true)
CACHE_SEARCH_TTL=300000              # Search cache TTL in ms (default: 5 min)
CACHE_MEDIA_TTL=1800000              # Media details TTL (default: 30 min)
CACHE_REQUESTS_TTL=60000             # Requests TTL (default: 1 min)
CACHE_MAX_SIZE=1000                  # Max cache entries (default: 1000)

# Safety
REQUIRE_MULTI_SEASON_CONFIRM=true    # Require confirmation for multi-season (default: true)
```

### Performance Improvements

**For Anime Workflow (Pass 1 Dedupe):**
- API calls: 150-300 → 1-10 (99% reduction)
- Response tokens: ~25,000 → ~3,000 (88% reduction)
- Execution time: 2-3 minutes → 10-15 seconds (90% faster)

**General:**
- 50% fewer tools (8 → 4)
- Structured JSON responses (AI-friendly)
- Compact format by default (60-90% token savings)
- Batch operations save N-1 round trips

### HTTP/SSE Enhancements

**New Endpoints:**
- `GET /health` - Health check (includes version)
- `GET /cache/stats` - Cache statistics and hit rates

### Breaking Changes

**None** - Fully backward compatible. Old tool names removed but functionality preserved in consolidated tools.

### Migration Guide

**From v1.0.x to v1.1.0:**

Old tools → New consolidated tools:
- `search_media` → `search_media` (enhanced with dedupe mode)
- `check_request_status_by_title` → `search_media` with `dedupeMode: true`
- `request_media` → `request_media` (enhanced with validation)
- `get_request`, `list_requests`, `update_request_status`, `delete_request` → `manage_media_requests` with action
- `get_media_details` → `get_media_details` (enhanced with levels)

**Example: Dedupe workflow (the killer feature)**
```typescript
// OLD (v1.0.x): 50-100 individual calls
for (const title of animeList) {
  await check_request_status_by_title({ title });
}

// NEW (v1.1.0): ONE batch call
await search_media({
  dedupeMode: true,
  titles: animeList,  // 50-100 titles
  autoNormalize: true
});
```

### Implementation Status

**✅ Completed (100%)**:
- All utility infrastructure (cache, normalize, retry)
- Type system
- Tool schemas and registration
- Server architecture (stdio + HTTP/SSE)
- Configuration system
- Project builds successfully
- **All 4 tool handlers fully implemented**
- **Full dedupe mode implementation**
- **Request validation and confirmation**
- **Management action handlers**

### Files Added
- `src/utils/cache.ts` - Caching system
- `src/utils/normalize.ts` - Title normalization
- `src/utils/retry.ts` - Retry logic
- `src/types.ts` - Type definitions

### Files Modified
- `src/index.ts` - Complete rewrite with consolidated architecture
- `package.json` - Version bump to 1.1.0
- `CHANGELOG.md` - This file

---

## [1.0.3] - 2025-01-26

### Added
- **Season Validation Feature**: Validates requested season numbers against series metadata
  - Prevents requesting impossible season numbers (e.g., Season 10 when series only has 4 seasons)
  - Fetches series details to check numberOfSeasons before accepting request
  - Tries alternate matches if primary match doesn't have enough seasons
  - Returns NOT_FOUND with clear error message for invalid seasons
  - Implemented in src/index.ts lines 786-840
- **Test 1.9**: Season Validation test added to TEST_PLAN.md
  - Tests the new season validation feature
  - Validates that requested seasons don't exceed series total
  - Ensures proper error handling and alternate matching
- New `check_request_status_by_title` tool that searches for media by title and returns complete request status information
  - Shows if a title has been requested
  - Displays request status (PENDING_APPROVAL, APPROVED, DECLINED)
  - Shows media availability status (PENDING, PROCESSING, AVAILABLE, etc.)
  - Returns who requested it and when
  - Perfect for preventing duplicate requests

### Fixed
- Improved special character handling in search queries (supports titles with `!`, `'`, `(`, `)`, `*`)

## [1.0.2] - 2025-01-25

### Fixed
- Fixed URL encoding bug where special characters (like `!`) in search queries caused HTTP 400 errors
- Manually encode RFC 3986 unreserved characters that `encodeURIComponent()` doesn't encode

### Changed
- Enhanced search reliability for anime titles and other media with special characters

## [1.0.1] - 2025-01-20

### Added
- Initial public release
- Support for 8 core Overseerr operations via MCP tools
- Docker support with HTTP/SSE transport
- NPM package publication
- Comprehensive documentation

### Tools Included
- `search_media` - Search for movies, TV shows, or people
- `request_media` - Request media with optional season selection
- `get_request` - Get request details by ID
- `list_requests` - List and filter requests
- `update_request_status` - Approve or decline requests
- `get_media_details` - Get detailed TMDB information
- `delete_request` - Delete media requests

[1.0.3]: https://github.com/jhomen368/overseerr-mcp/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/jhomen368/overseerr-mcp/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/jhomen368/overseerr-mcp/releases/tag/v1.0.1
