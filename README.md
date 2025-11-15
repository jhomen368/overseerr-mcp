# Overseerr MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docker](https://img.shields.io/badge/docker-%230db7ed.svg?style=flat&logo=docker&logoColor=white)](https://github.com/jhomen368/overseerr-mcp/pkgs/container/overseerr-mcp)
[![Version](https://img.shields.io/badge/version-1.1.0-blue.svg)](https://github.com/jhomen368/overseerr-mcp)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that provides AI assistants with direct integration to [Overseerr](https://overseerr.dev/), enabling automated media discovery, requests, and management for your Plex ecosystem.

## What is MCP?

The Model Context Protocol (MCP) is an open protocol that enables seamless integration between AI applications and external data sources. This server implements MCP to give AI assistants like Claude the ability to interact with your Overseerr instance.

## Features

This server provides 4 powerful, consolidated tools for interacting with your Overseerr instance:

### Available Tools

#### 1. **search_media** - Unified Search & Dedupe
Search for media with optional batch dedupe mode optimized for workflows that check many titles at once.

**Modes**:
- **Single search**: Find movies/TV shows/people
- **Batch search**: Multiple queries in one call
- **Dedupe mode**: Check 50-100 titles for request status (99% fewer API calls!)

**Example - Batch Dedupe (Anime Workflow)**:
```typescript
search_media({
  dedupeMode: true,
  titles: [
    "Frieren: Beyond Journey's End",
    "My Hero Academia Season 7",
    "Demon Slayer Season 4",
    // ... 47 more  titles
  ],
  autoNormalize: true  // Strips "Season N", "Part N", etc.
})
```

**Response**:
```json
{
  "summary": {
    "total": 50,
    "pass": 35,
    "blocked": 15,
    "passRate": "70%"
  },
  "results": [
    {
      "title": "Frieren: Beyond Journey's End",
      "id": 209867,
      "status": "pass"
    },
    {
      "title": "My Hero Academia Season 7",
      "id": 155688,
      "status": "pass",
      "franchiseInfo": "Base series: S1-S6 in library"
    },
    {
      "title": "Demon Slayer Season 4",
      "id": 196556,
      "status": "blocked",
      "reason": "Season already requested (APPROVED)"
    }
  ]
}
```

---

#### 2. **request_media** - Smart Media Requests
Request movies or TV shows with automatic validation and multi-season confirmation.

**Features**:
- Single or batch requests
- Multi-season confirmation (prevents accidental bulk downloads)
- Pre-request validation (checks if already requested/available)
- Dry-run mode (preview without requesting)

**Example - Single Request**:
```typescript
request_media({
  mediaType: "movie",
  mediaId: 438631
})
```

**Example - TV Show with Confirmation**:
```typescript
request_media({
  mediaType: "tv",
  mediaId: 82856,
  seasons: "all"
})

// First returns:
{
  "requiresConfirmation": true,
  "media": {
    "title": "The Bear",
    "totalSeasons": 3,
    "totalEpisodes": 28
  },
  "message": "This will request 3 seasons. Add 'confirmed: true' to proceed."
}

// Then confirm:
request_media({
  mediaType: "tv",
  mediaId: 82856,
  seasons: "all",
  confirmed: true
})
```

**Example - Batch Requests**:
```typescript
request_media({
  items: [
    { mediaType: "movie", mediaId: 438631 },
    { mediaType: "tv", mediaId: 209867, seasons: "all" }
  ]
})
```

---

#### 3. **manage_media_requests** - All Request Management
Unified tool for all request management operations.

**Actions**: get, list, approve, decline, delete

**Example - List with Summary**:
```typescript
manage_media_requests({
  action: "list",
  summary: true
})

// Returns statistics instead of full list:
{
  "total": 57,
  "statusBreakdown": {
    "PENDING_APPROVAL": 12,
    "APPROVED": 8,
    "AVAILABLE": 30
  }
}
```

**Example - Batch Approve**:
```typescript
manage_media_requests({
  action: "approve",
  requestIds: [123, 124, 125]
})
```

**Example - List with Filters**:
```typescript
manage_media_requests({
  action: "list",
  filter: "pending",
  take: 20
})
```

---

#### 4. **get_media_details** - Flexible Detail Lookup
Get detailed information with level control and batch support.

**Levels**:
- **basic**: Essential info only (id, title, year, rating)
- **standard**: + overview, genres, runtime, seasons
- **full**: Complete API response

**Example - Single Lookup**:
```typescript
get_media_details({
  mediaType: "movie",
  mediaId: 438631,
  level: "basic"
})
```

**Example - Batch Lookup**:
```typescript
get_media_details({
  items: [
    { mediaType: "movie", mediaId: 438631 },
    { mediaType: "tv", mediaId: 82856 }
  ]
})
```

## Prerequisites

- Node.js 18.0 or higher
- An Overseerr instance (self-hosted or managed)
- Overseerr API key (Settings → General in your Overseerr instance)

## Configuration

### Local Development (stdio mode)

Configure the server with environment variables:

- `OVERSEERR_URL`: Your Overseerr instance URL (e.g., https://overseerr.example.com)
- `OVERSEERR_API_KEY`: Your API key from Overseerr Settings → General

### Docker/HTTP Mode (Streamable HTTP with SSE)

When running in Docker, HTTP transport with Server-Sent Events (SSE) is enabled by default. The following environment variables are **required**:

- `OVERSEERR_URL`: Your Overseerr instance URL
- `OVERSEERR_API_KEY`: Your Overseerr API key

The Docker image has these defaults (no need to override unless you want to change them):
- `HTTP_MODE`: `true` (HTTP transport enabled)
- `PORT`: `8085` (MCP server port)

## Installation

### NPM Installation

```bash
npm install -g @jhomen368/overseerr-mcp
```

### From Source

```bash
git clone https://github.com/jhomen368/overseerr-mcp.git
cd overseerr-mcp
npm install
npm run build
```

### Docker Build

Build the Docker image locally:

```bash
docker build -t overseerr-mcp .
```

Or pull from GitHub Container Registry:

```bash
docker pull ghcr.io/jhomen368/overseerr-mcp:latest
```

## Docker Usage

### Running with Docker

#### Basic Docker Run

```bash
docker run -d \
  --name overseerr-mcp \
  -p 8085:8085 \
  -e OVERSEERR_URL=https://your-overseerr-instance.com \
  -e OVERSEERR_API_KEY=your-api-key-here \
  ghcr.io/jhomen368/overseerr-mcp:latest
```

#### Using Environment File

Create a `.env` file:

```env
OVERSEERR_URL=https://your-overseerr-instance.com
OVERSEERR_API_KEY=your-api-key-here
```

Then run:

```bash
docker run -d \
  --name overseerr-mcp \
  -p 8085:8085 \
  --env-file .env \
  ghcr.io/jhomen368/overseerr-mcp:latest
```

### Using Docker Compose

Create a `docker-compose.yml` file:

```yaml
version: '3.8'

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
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:8085/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
```

Start the service:

```bash
docker-compose up -d
```

### HTTP Endpoints

When running in HTTP mode with streamable transport, the server exposes:

#### `POST /mcp`
The main MCP endpoint using Server-Sent Events for streaming communication. This is the endpoint you'll configure in your MCP client to connect to the server.

#### `GET /health`
Health check endpoint that returns server status:

```bash
curl http://localhost:8085/health
```

Response:
```json
{
  "status": "ok",
  "service": "overseerr-mcp"
}
```

### Verifying the Server

Check if the server is running:

```bash
# Check health endpoint
curl http://localhost:8085/health

# Check container logs
docker logs overseerr-mcp

# Check container status
docker ps | grep overseerr-mcp
```

### Connecting MCP Clients

To connect an MCP client to the HTTP server, configure it with:

- **Transport**: Streamable HTTP (via SSE)
- **URL**: `http://localhost:8085/mcp` (or your server's address)
- **Method**: POST

The server uses Server-Sent Events (SSE) as the underlying mechanism for streamable HTTP transport, enabling efficient bidirectional communication.

## Configuring with MCP Clients

### Claude Desktop

Add to your Claude Desktop configuration file:

**MacOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

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

### Other MCP Clients

For clients supporting streamable HTTP transport, configure with:

- **URL**: `http://localhost:8085/mcp`
- **Transport**: Streamable HTTP (SSE)
- **Method**: POST

Then start the server in HTTP mode using Docker (see Docker Usage section).

## Usage Examples

Once configured, you can ask your AI assistant to:

- "Search for the movie Inception in Overseerr"
- "Check if The Matrix has already been requested"
- "Has anyone requested Breaking Bad yet?"
- "Request the TV show Breaking Bad, all seasons"
- "List all pending media requests"
- "Show me all available media in the library"
- "Get details for request ID 123"
- "Approve request ID 45"
- "Show me information about the movie with TMDB ID 550"
- "What's the status of my request for Dune?"

## API Reference

The server uses the Overseerr API v1. For more details, see:
- [Overseerr API Documentation](https://api-docs.overseerr.dev/)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## Troubleshooting

### Connection Issues

1. Verify your Overseerr URL is accessible from where the server runs
2. Ensure your API key is valid (Overseerr Settings → General)
3. Check firewall rules if running remotely

### Docker Issues

1. Verify environment variables are set correctly
2. Check container logs: `docker logs overseerr-mcp`
3. Ensure port 8085 is not already in use

### Build Issues

1. Ensure Node.js version is 18.0 or higher
2. Clear node_modules and reinstall: `rm -rf node_modules && npm install`
3. Rebuild TypeScript: `npm run build`

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Overseerr](https://overseerr.dev/) - Media request and discovery tool
- [Model Context Protocol](https://modelcontextprotocol.io) - Open protocol for AI integrations
- [Anthropic](https://www.anthropic.com/) - Creators of the MCP standard
