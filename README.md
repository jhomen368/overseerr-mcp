# Overseerr MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP Badge](https://lobehub.com/badge/mcp/jhomen368-overseerr-mcp)](https://lobehub.com/mcp/jhomen368-overseerr-mcp)
[![Docker](https://img.shields.io/badge/docker-%230db7ed.svg?style=flat&logo=docker&logoColor=white)](https://github.com/jhomen368/overseerr-mcp/pkgs/container/overseerr-mcp)
[![Version](https://img.shields.io/badge/version-1.2.3-blue.svg)](https://github.com/jhomen368/overseerr-mcp)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://www.paypal.com/donate?hosted_button_id=PBRD7FXKSKAD2)

> **A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server providing AI assistants with direct integration to [Overseerr](https://overseerr.dev/) for automated media discovery, requests, and management in your Plex ecosystem.**

## ✨ What's New in v1.2.3

- **Documentation**: Complete README overhaul for clarity and professionalism
- See [CHANGELOG.md](CHANGELOG.md) for full version history

## 🎯 Key Features

- **🚀 99% fewer API calls** for batch operations (150-300 → 1)
- **⚡ 88% token reduction** with compact response formats  
- **🎯 Batch Dedupe Mode** - Check 50-100 titles in one operation
- **🔄 Smart Caching** - 70-85% API call reduction
- **🛡️ Safety Features** - Multi-season confirmation, validation
- **📦 4 Powerful Tools** - Consolidated from 8 for clarity

## 🛠️ Available Tools

| Tool | Purpose | Key Features |
|------|---------|--------------|
| **search_media** | Search & dedupe | Single/batch search, dedupe mode for 50-100 titles, franchise awareness |
| **request_media** | Request movies/TV | Batch requests, season validation, multi-season confirmation, dry-run mode |
| **manage_media_requests** | Manage requests | List/approve/decline/delete, filtering, summary statistics |
| **get_media_details** | Get media info | Batch lookup, flexible detail levels (basic/standard/full) |

## 📋 Prerequisites

- **Node.js** 18.0 or higher
- **Overseerr instance** (self-hosted or managed)
- **Overseerr API key** (Settings → General in Overseerr)

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
    "overseerr": {
      "command": "npx",
      "args": ["-y", "@jhomen368/overseerr-mcp"],
      "env": {
        "OVERSEERR_URL": "https://overseerr.example.com",
        "OVERSEERR_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Option 2: Docker (Remote Access)

```bash
docker run -d \
  --name overseerr-mcp \
  -p 8085:8085 \
  -e OVERSEERR_URL=https://your-overseerr-instance.com \
  -e OVERSEERR_API_KEY=your-api-key-here \
  ghcr.io/jhomen368/overseerr-mcp:latest
```

**Docker Compose:**

```yaml
services:
  overseerr-mcp:
    image: ghcr.io/jhomen368/overseerr-mcp:latest
    container_name: overseerr-mcp
    ports:
      - "8085:8085"
    environment:
      - OVERSEERR_URL=https://your-overseerr-instance.com
      - OVERSEERR_API_KEY=your-api-key-here
    restart: unless-stopped
```

**Test the server:**
```bash
curl http://localhost:8085/health
```

**Connect MCP clients:**
- **Transport**: Streamable HTTP (SSE)
- **URL**: `http://localhost:8085/mcp`

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

### Natural Language Examples

Simply ask your AI assistant:

- "Search for Inception in Overseerr"
- "Check if these 50 anime titles have been requested"
- "Request Breaking Bad all seasons"
- "Show me all pending media requests"
- "Approve request ID 123"
- "Get details for TMDB ID 550"

## ⚙️ Configuration

### Environment Variables

**Required:**
- `OVERSEERR_URL` - Your Overseerr instance URL
- `OVERSEERR_API_KEY` - API key from Overseerr Settings → General

**Optional (with defaults):**
```bash
CACHE_ENABLED=true                   # Enable caching
CACHE_SEARCH_TTL=300000             # Search cache: 5 min
CACHE_MEDIA_TTL=1800000             # Media cache: 30 min
CACHE_REQUESTS_TTL=60000            # Request cache: 1 min
CACHE_MAX_SIZE=1000                 # Max cache entries
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
- Verify Overseerr URL is accessible
- Check API key validity (Settings → General)
- Review firewall rules for remote access

### Docker Issues
```bash
# Check logs
docker logs overseerr-mcp

# Verify health
curl http://localhost:8085/health

# Restart container
docker restart overseerr-mcp
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

- [Overseerr](https://overseerr.dev/) - Media request and discovery tool
- [Model Context Protocol](https://modelcontextprotocol.io) - Open protocol for AI integrations
- [Anthropic](https://www.anthropic.com/) - Creators of the MCP standard

---

**Support this project:** [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://www.paypal.com/donate?hosted_button_id=PBRD7FXKSKAD2)
