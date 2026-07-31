# Multi-stage build for Overseerr MCP Server
FROM node:26-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Upgrade all packages to fix known vulnerabilities, then install dependencies
RUN apk upgrade --no-cache && \
    npm ci

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Prune to production-only deps in builder (avoids npm existing in production image)
RUN npm ci --omit=dev

# Production stage
FROM node:26-alpine

# Set working directory
WORKDIR /app

# Upgrade all packages to fix known vulnerabilities, then install dumb-init for proper signal handling
RUN apk upgrade --no-cache && \
    apk add --no-cache dumb-init

# Remove npm — not needed at runtime, eliminates its bundled CVE surface
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx

# Copy production node_modules and built files from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build

# Create a non-root user
RUN addgroup -g 1001 -S mcpuser && \
    adduser -S mcpuser -u 1001

# Change ownership
RUN chown -R mcpuser:mcpuser /app

# Switch to non-root user
USER mcpuser

# Expose port
EXPOSE 8085

# Environment variables
# These MUST be provided at runtime:
# - SEERR_URL or OVERSEERR_URL (legacy): Your Seerr/Overseerr instance URL
# - SEERR_API_KEY or OVERSEERR_API_KEY (legacy): Your API key
# Note: SEERR_* variables are preferred; OVERSEERR_* will show deprecation warnings
ENV HTTP_MODE=true \
    PORT=8085 \
    NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8085/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# OCI labels for metadata
LABEL org.opencontainers.image.title="Overseerr MCP Server" \
      org.opencontainers.image.description="Model Context Protocol server for Overseerr integration" \
      org.opencontainers.image.source="https://github.com/jhomen368/overseerr-mcp" \
      org.opencontainers.image.licenses="MIT"

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Run the server
CMD ["node", "build/index.js"]
