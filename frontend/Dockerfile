FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED=false
ENV NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED=$NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

EXPOSE 3000
USER nextjs
ENV HOSTNAME=0.0.0.0 PORT=3000
CMD ["node", "server.js"]
