# Meridian: one image for the web app, the worker and the scheduler. docker-compose.yml chooses the command for each.
# Build and run the whole stack with: docker compose up --build
FROM node:22-bookworm-slim

# ffmpeg runs the media functions in-process on the worker when MEDIA_FUNCTIONS_MODE=in_process (owner decision 2026-10-16,
# src/engine/media/local.ts). docker-compose builds the web, worker and scheduler services from this file.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a code change does not install them again.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# No DATABASE_URL at build time, so the build skips the migrations. The web service applies them when it starts.
RUN npm run build

ENV NODE_ENV=production
EXPOSE 8080

# The web app. The worker and the scheduler override this command in docker-compose.yml.
CMD ["sh", "-c", "node scripts/migrate.mjs && npm run preview -- --host 0.0.0.0 --port 8080"]
