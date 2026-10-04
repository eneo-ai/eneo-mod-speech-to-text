# One image, one process: `python -m app.serve` serves the built UI and the API on port 3001. No Node, no supervisor and no
# package manager's cache at run time. Base images are pinned to the digest of the tag named beside them; the update routine
# is in docs/operations.md.
#
#   docker build -t eneo-mod-speech-to-text .
#   docker build --build-arg SPEAKER_REVIEW_ENABLED=true -t eneo-mod-speech-to-text:review .

# ---- the UI, built to static files (frontend/dist). engine-strict: the base image must meet the Node floor package.json declares.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS web
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --engine-strict
COPY frontend/ ./
# The build type-checks the production tests, and tests/prod/headers.spec.ts reads the backend's header definition from its place in the repository.
COPY backend/app/security_headers.json /build/backend/app/security_headers.json
ARG SPEAKER_REVIEW_ENABLED=false
ENV SPEAKER_REVIEW_ENABLED=$SPEAKER_REVIEW_ENABLED
RUN npm run build

# ---- the backend's packages: exactly the set backend/requirements.lock names, each checked against its hash, nothing resolved here.
FROM python:3.12-slim@sha256:dddfd7e07f9d15aeeca61529320492139d21cac7f0070c00609243e51e4e0016 AS python-packages
RUN python -m venv /opt/venv
COPY backend/requirements.lock ./
RUN /opt/venv/bin/pip install --no-cache-dir --require-hashes --no-deps -r requirements.lock

# ---- what runs. The code is owned by root: the process (user `module`) can read it and cannot change it.
FROM python:3.12-slim@sha256:dddfd7e07f9d15aeeca61529320492139d21cac7f0070c00609243e51e4e0016
RUN groupadd --system module && useradd --system --gid module --home-dir /app module
COPY --from=python-packages /opt/venv /opt/venv
WORKDIR /app
COPY backend/app ./backend/app
COPY --from=web /build/frontend/dist ./web
ENV PATH=/opt/venv/bin:$PATH PYTHONPATH=/app/backend STATIC_DIR=/app/web \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER module
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3001/health', timeout=3)"
CMD ["python", "-m", "app.serve"]
