FROM node:24-alpine AS build
WORKDIR /app
COPY app/package*.json ./
RUN npm ci
COPY app/ ./
RUN npm run build

FROM node:24-alpine AS production
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
WORKDIR /app
COPY app/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir /data && chown node:node /data
COPY --from=build /app/dist ./dist
COPY app/server ./server
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/index.mjs"]