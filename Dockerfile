FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public

# Create persistent storage volume mount point
RUN mkdir -p /data/cardng-storage && chown -R node:node /data/cardng-storage /app

USER node

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0
ENV STORAGE_ROOT=/data/cardng-storage

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:4000/api/health || exit 1

CMD ["node", "src/server.mjs"]
