# Seerr MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docker](https://img.shields.io/badge/docker-%230db7ed.svg?style=flat&logo=docker&logoColor=white)](https://github.com/jhomen368/overseerr-mcp/pkgs/container/overseerr-mcp)
[![Version](https://img.shields.io/badge/version-2.1.3-blue.svg)](https://github.com/jhomen368/overseerr-mcp)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://www.paypal.com/donate?hosted_button_id=PBRD7FXKSKAD2)

> **A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for Overseerr and Seerr (the unified successor) that enables AI assistants to search, request, and manage media through the Model Context Protocol.**

## 🎯 Key Features

- **🚀 99% fewer API calls** for batch operations (150-300 → 1)
- **⚡ 88% token reduction** with compact response formats  
- **🎯 Batch Dedupe Mode** - Check 50-100 titles in one operation
- **🔄 Smart Caching** - 70-85% API call reduction
- **🛡️ Safety Features** - Multi-season confirmation, validation
- **📦 6 Tools** - Search, request, and manage media | Discover Radarr/Sonarr server configurations

## 🔒 Security

- **🤖 Automated Security Scanning**
  - Dependabot for dependency updates (weekly)
  - CodeQL for code vulnerability analysis (PR + weekly)
  - Trivy for Docker image scanning (CI only - blocks PRs if vulnerabilities found)
  - CI validates everything during PR review, CD trusts CI and publishes
- **🐳 Hardened Docker Images**
  - Non-root user (mcpuser)
  - Multi-stage builds
  - Minimal Alpine base
  - dumb-init process management
- **✅ Input Validation**
  - URL and API key format validation
  - Fails fast with clear error messages

## 🛠️ Available Tools

| Tool | Purpose | Key Features |
|------|---------|--------------|
| **search_media** | Search & dedupe | Single/batch search, dedupe mode for 50-100 titles, franchise awareness |
| **request_media** | Request movies/TV | Batch requests, season validation, multi-season confirmation, dry-run mode |
| **manage_media_requests** | Manage requests | List/approve/decline/delete, filtering, summary statistics |
| **get_media_details** | Get media info | Batch lookup, flexible detail levels (basic/standard/full) |
| **get_services** | List Radarr/Sonarr servers | Discover server IDs, active defaults, 4K status |
| **get_service_details** | Get server config | Quality profiles, root folders, tags per server |

## 📋 Prerequisites

- **Node.js** 18.0 or higher
- **Seerr or Overseerr instance** (self-hosted or managed)
- **Seerr/Overseerr API key** (Settings → General in your instance)

## 🚀 Quick Start

### Option 1: NPM (Recommended)

```bash
npm install -g @jhomen368/overseerr-mcp
```

**Configure with Claude Desktop:**

Add to your configuration file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "seerr": {
      "command": "npx",
      "args": ["-y", "@jhomen368/overseerr-mcp"],
      "env": {
        "SEERR_URL": "https://seerr.example.com",
        "SEERR_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

> **Legacy Overseerr Users:** If you're still using Overseerr (not Seerr), you can continue using the legacy variables:
> ```json
> {
>   "env": {
>     "OVERSEERR_URL": "https://overseerr.example.com",
>     "OVERSEERR_API_KEY": "your-api-key-here"
>   }
> }
> ```
> *Both `OVERSEERR_*` and `SEERR_*` variables are supported for backward compatibility. Legacy variables will be removed in v3.0.0.*

### Option 2: Docker (Remote Access)

The official image is published to GitHub Container Registry (GHCR):

```bash
docker run -d \
  --name seerr-mcp \
  -p 8085:8085 \
  -e SEERR_URL=https://your-seerr-instance.com \
  -e SEERR_API_KEY=your-api-key-here \
  ghcr.io/jhomen368/overseerr-mcp:latest
```

**Docker Compose:**

```yaml
services:
  seerr-mcp:
    image: ghcr.io/jhomen368/overseerr-mcp:latest
    container_name: seerr-mcp
    ports:
      - "8085:8085"
    environment:
      SEERR_URL: https://your-seerr-instance.com
      SEERR_API_KEY: your-api-key-here
    restart: unless-stopped
```

**Using a fork image:**

This repository publishes Docker images from GitHub Actions on pushes to `main`, tags like `v2.1.3`, and manual `workflow_dispatch` runs. If you fork the repository and enable GitHub Actions, your fork publishes its own image at:

```text
ghcr.io/<your-github-user-or-org>/<your-fork-repo>:latest
```

For the common case where the fork is still named `overseerr-mcp`, use:

```yaml
services:
  seerr-mcp:
    image: ghcr.io/<your-github-user-or-org>/overseerr-mcp:latest
    container_name: seerr-mcp
    ports:
      - "8085:8085"
    environment:
      SEERR_URL: https://your-seerr-instance.com
      SEERR_API_KEY: your-api-key-here
    restart: unless-stopped
```

If your fork or package is private, authenticate the Docker host first with `docker login ghcr.io` using a GitHub token that can read packages.

**Test the server:**
```bash
curl http://localhost:8085/health
```

**Connect MCP clients:**
- **Transport**: Streamable HTTP
- **URL**: `http://localhost:8085/mcp`

**Claude custom connector:**

Expose the container over HTTPS at a publicly reachable URL and add that `/mcp` URL as a Claude custom connector. No Supergateway sidecar is required for Docker or `HTTP_MODE=true`; the server now speaks native Streamable HTTP. Keep `SEERR_API_KEY` (or legacy `OVERSEERR_API_KEY`) only in the server environment so it is never sent to Claude.

Example Docker Compose for a Claude-compatible remote MCP endpoint behind your reverse proxy:

```yaml
services:
  seerr-mcp:
    image: ghcr.io/jhomen368/overseerr-mcp:latest
    container_name: seerr-mcp
    ports:
      - "8085:8085"
    environment:
      SEERR_URL: https://your-seerr-instance.com
      SEERR_API_KEY: your-api-key-here
      HTTP_MODE: "true"
      PORT: "8085"
    restart: unless-stopped
```

Add `https://your-public-host.example.com/mcp` in Claude's custom connector settings. This endpoint is authless from Claude's perspective; access control should be handled by where and how you expose the server, while the Seerr/Overseerr API key remains server-side.

### Option 3: From Source

```bash
git clone https://github.com/jhomen368/overseerr-mcp.git
cd overseerr-mcp
npm install
npm run build
node build/index.js
```

## 💡 Usage Examples

### Batch Dedupe Workflow (Perfect for Anime Seasons)

```typescript
// Check 50-100 titles in ONE API call
search_media({
  dedupeMode: true,
  titles: [
    "Frieren: Beyond Journey's End",
    "My Hero Academia Season 7",
    "Demon Slayer Season 4",
    // ... 47 more titles
  ],
  autoNormalize: true  // Strips "Season N", "Part N", etc.
})
```

**Response:**
```json
{
  "summary": {
    "total": 50,
    "pass": 35,
    "blocked": 15,
    "passRate": "70%"
  },
  "results": [
    { "title": "Frieren", "status": "pass", "id": 209867 },
    { "title": "My Hero Academia S7", "status": "pass", "franchiseInfo": "S1-S6 in library" },
    { "title": "Demon Slayer S4", "status": "blocked", "reason": "Already requested" }
  ]
}
```

### Request Media with Validation

```typescript
// Single movie request
request_media({
  mediaType: "movie",
  mediaId: 438631
})

// TV show with specific seasons
request_media({
  mediaType: "tv",
  mediaId: 82856,
  seasons: [1, 2]
})

// All seasons (excludes season 0 by default)
request_media({
  mediaType: "tv",
  mediaId: 82856,
  seasons: "all"
})
```

### Manage Requests

```typescript
// List with filters
manage_media_requests({
  action: "list",
  filter: "pending",
  take: 20
})

// Batch approve
manage_media_requests({
  action: "approve",
  requestIds: [123, 124, 125]
})

// Get summary statistics
manage_media_requests({
  action: "list",
  summary: true
})
```

### Service Discovery

```typescript
// List all configured servers (Radarr + Sonarr)
get_services({})

// List only Radarr servers
get_services({ serviceType: "radarr" })

// Get quality profiles, root folders, and tags for a server
get_service_details({
  serviceType: "radarr",
  serverId: 0
})

// Use discovered values when requesting media
request_media({
  mediaType: "movie",
  mediaId: 438631,
  serverId: 0,
  profileId: 13,
  rootFolder: "/data/media/movies"
})
```

### Natural Language Examples

Simply ask your AI assistant:

- "Search for Inception in Seerr"
- "Check if these 50 anime titles have been requested"
- "Request Breaking Bad all seasons"
- "Show me all pending media requests"
- "Approve request ID 123"
- "Get details for TMDB ID 550"
- "What Radarr servers are configured?"
- "Show me the quality profiles for my Sonarr server"

## ⚙️ Configuration

### Environment Variables

**Required:**
- `SEERR_URL` - Your Seerr/Overseerr instance URL
- `SEERR_API_KEY` - API key from Settings → General

**Legacy (deprecated, will be removed in v3.0.0):**
- `OVERSEERR_URL` - Use `SEERR_URL` instead
- `OVERSEERR_API_KEY` - Use `SEERR_API_KEY` instead

**Optional (with defaults):**
```bash
CACHE_ENABLED=true                   # Enable caching
CACHE_SEARCH_TTL=300000             # Search cache: 5 min
CACHE_MEDIA_TTL=1800000             # Media cache: 30 min
CACHE_REQUESTS_TTL=60000            # Request cache: 1 min
CACHE_MAX_SIZE=1000                 # Max cache entries
CACHE_SERVICES_TTL=600000           # Services cache: 10 min
CACHE_SERVICEDETAILS_TTL=600000     # Service details cache: 10 min
REQUIRE_MULTI_SEASON_CONFIRM=true   # Confirm >24 episodes
HTTP_MODE=false                      # Enable HTTP transport
PORT=8085                            # HTTP server port
```

## 📚 Documentation

- **[CHANGELOG.md](CHANGELOG.md)** - Version history and release notes
- **[CONTRIBUTING.md](CONTRIBUTING.md)** - Contribution guidelines
- **[Overseerr API Docs](https://api-docs.overseerr.dev/)** - Official API reference

## 🔧 Troubleshooting

### Connection Issues
- Verify Seerr/Overseerr URL is accessible
- Check API key validity (Settings → General)
- Review firewall rules for remote access

### Docker Issues
```bash
# Check logs
docker logs seerr-mcp

# Verify health
curl http://localhost:8085/health

# Restart container
docker restart seerr-mcp
```

### Build Issues
```bash
# Ensure Node.js 18+
node --version

# Clean rebuild
rm -rf node_modules build
npm install
npm run build
```

## 🤝 Contributing

Contributions welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📄 License

MIT License - see [LICENSE](LICENSE) for details

## 🙏 Acknowledgments

- [Seerr](https://github.com/seerr) - Next-generation media request and discovery tool
- [Overseerr](https://overseerr.dev/) - Original media request tool for Plex
- [Model Context Protocol](https://modelcontextprotocol.io) - Open protocol for AI integrations
- [Anthropic](https://www.anthropic.com/) - Creators of the MCP standard

---

**Support this project:** [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://www.paypal.com/donate?hosted_button_id=PBRD7FXKSKAD2)
