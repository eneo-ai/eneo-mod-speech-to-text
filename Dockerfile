# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS frontend-build
WORKDIR /build/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
ENV INTERNAL_API_BASE=http://127.0.0.1:8000 \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build


FROM python:3.12-slim AS backend-build
WORKDIR /build/backend

RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

COPY backend/requirements-runtime.txt backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements-runtime.txt


FROM python:3.12-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system module \
    && useradd --system --gid module --home-dir /app module

COPY --from=node:20-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=backend-build /opt/venv /opt/venv

WORKDIR /app
COPY --chown=module:module backend/app ./backend/app
COPY --chown=module:module deploy/supervisord.conf ./deploy/supervisord.conf
COPY --from=frontend-build --chown=module:module /build/frontend/.next/standalone ./frontend
COPY --from=frontend-build --chown=module:module /build/frontend/.next/static ./frontend/.next/static
COPY --from=frontend-build --chown=module:module /build/frontend/public ./frontend/public

ENV HOSTNAME=0.0.0.0 \
    INTERNAL_API_BASE=http://127.0.0.1:8000 \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3001 \
    PYTHONPATH=/app/backend \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

USER module
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3001/health', timeout=3)"

CMD ["/opt/venv/bin/supervisord", "-c", "/app/deploy/supervisord.conf"]
