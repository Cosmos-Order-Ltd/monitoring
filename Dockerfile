# Multi-stage Dockerfile for PMS Monitoring Dashboard
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/
COPY public/ ./public/ 2>/dev/null || true

# Build application
RUN npm run build

# Production stage
FROM node:20-alpine AS runtime

# Install security updates and required packages
RUN apk update && apk upgrade && apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S pms && \
    adduser -S pms -u 1001

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder --chown=pms:pms /app/dist ./dist
COPY --from=builder --chown=pms:pms /app/public ./public 2>/dev/null || true

# Create logs directory
RUN mkdir -p /app/logs && chown -R pms:pms /app

# Switch to non-root user
USER pms

# Expose port
EXPOSE 9090

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:9090/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# Start application with dumb-init
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]