FROM node:24-alpine AS deps
WORKDIR /build
COPY package.json package-lock.json ./
# Pin npm to the version used on the dev machine: newer npm rejects lockfiles
# whose optional platform deps were pruned by older npm (@emnapi entries).
RUN npm install -g npm@11.6.2 && npm ci

FROM node:24-alpine AS build
WORKDIR /build
COPY --from=deps /build/node_modules ./node_modules
COPY . .
RUN npm run build

# The standalone output bundles server deps into chunks, so the migration
# script gets its own copy of drizzle-orm + pg here.
FROM node:24-alpine AS migrate-deps
WORKDIR /migrate
RUN npm install --no-save drizzle-orm@0.45 pg@8

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# uid 1001 must match the pdf-service image's user: both containers share
# the pdf_files volume mounted at /data/files.
RUN addgroup -S -g 1001 app && adduser -S -u 1001 -G app app

COPY --from=build --chown=app:app /build/.next/standalone ./
COPY --from=build --chown=app:app /build/.next/static ./.next/static
COPY --from=build --chown=app:app /build/public ./public
COPY --from=migrate-deps /migrate/node_modules ./migrate/node_modules
COPY scripts/migrate.mjs ./migrate/migrate.mjs
COPY drizzle ./drizzle
COPY docker-entrypoint.sh /docker-entrypoint.sh

RUN mkdir -p /data/files && chown app:app /data/files
USER app

ENV HOSTNAME=0.0.0.0 PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["sh", "/docker-entrypoint.sh"]
