# Overseerr MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docker](https://img.shields.io/badge/docker-%230db7ed.svg?style=flat&logo=docker&logoColor=white)](https://github.com/jhomen368/overseerr-mcp/pkgs/container/overseerr-mcp)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that provides AI assistants with direct integration to [Overseerr](https://overseerr.dev/), enabling automated media discovery, requests, and management for your Plex ecosystem.

## What is MCP?

The Model Context Protocol (MCP) is an open protocol that enables seamless integration between AI applications and external data sources. This server implements MCP to give AI assistants like Claude the ability to interact with your Overseerr instance.

## Features

This server provides the following tools for interacting with your Overseerr instance:

### Available Tools

1. **search_media** - Search for movies, TV shows, or people in Overseerr
   - Returns search results with media details including title, overview, release date, and rating
   
2. **request_media** - Request a movie or TV show
   - For TV shows, you can request specific seasons or all seasons
   - Supports 4K requests
   - Optional server, profile, and root folder configuration

3. **get_request** - Get details of a specific media request by ID
   - View request status, media status, requester, and timestamps

4. **list_requests** - List media requests with optional filtering
   - Filter by status (pending, approved, available, etc.)
   - Pagination support
   - Sort by added or modified date

5. **update_request_status** - Approve or decline media requests
   - Requires MANAGE_REQUESTS permission or ADMIN

6. **get_media_details** - Get detailed information about a movie or TV show
   - Fetches comprehensive TMDB data

7. **delete_request** - Delete a media request
   - Users can delete their own pending requests

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
npm install -g overseerr-mcp
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
      "args": ["-y", "overseerr-mcp"],
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
- "Request the TV show Breaking Bad, all seasons"
- "List all pending media requests"
- "Get details for request ID 123"
- "Approve request ID 45"
- "Show me information about the movie with TMDB ID 550"

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
