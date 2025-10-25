# Multi-stage build for Overseerr MCP Server
FROM node:22-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy built files from builder
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
# - OVERSEERR_URL: Your Overseerr instance URL (e.g., https://overseerr.example.com)
# - OVERSEERR_API_KEY: Your Overseerr API key
ENV HTTP_MODE=true
ENV PORT=8085

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8085/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Run the server
CMD ["node", "build/index.js"]
