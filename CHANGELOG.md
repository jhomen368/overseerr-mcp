# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.3] - 2025-01-26

### Added
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
