# Build context is the repository root (Render: Docker context ".", Dockerfile "services/api/Dockerfile").
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY packages ./packages
COPY services/api ./services/api
WORKDIR /app/services/api
RUN npm install --omit=dev --no-audit --no-fund
ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "--experimental-strip-types", "src/server.ts"]
