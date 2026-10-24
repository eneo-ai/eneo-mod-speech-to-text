# One image, one process: `python -m app.serve` serves the built UI and the API on port 3001. No Node, no supervisor and no
# package manager's cache at run time. Base images are pinned to the digest of the tag named beside them; the update routine
# is in docs/operations.md.
#
#   docker build -t eneo-mod-speech-to-text .
#   docker build --build-arg SPEAKER_REVIEW_ENABLED=true -t eneo-mod-speech-to-text:review .
#
# CI's build (ci.yml) also passes SOURCE_REVISION and BUILD_DATE: the commit and the time of the build, which the image
# then says in its labels and its /health. A build without them, as the two above, says neither.

# ---- the UI, built to static files (frontend/dist). engine-strict: the base image must meet the Node floor package.json declares.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS web
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
FROM python:3.14.8-slim@sha256:3353bb7e9ae99c7cce6cad2b2f2b174e8f22813ac43e3b13e7a742627d2b01d8 AS python-packages
RUN python -m venv /opt/venv
COPY backend/requirements.lock ./
RUN /opt/venv/bin/pip install --no-cache-dir --require-hashes --no-deps -r requirements.lock

# ---- what runs. The code is owned by root: the process (user `module`, uid and gid 999) can read it and cannot change it.
FROM python:3.14.8-slim@sha256:3353bb7e9ae99c7cce6cad2b2f2b174e8f22813ac43e3b13e7a742627d2b01d8
RUN groupadd --system --gid 999 module && useradd --system --uid 999 --gid module --home-dir /app module
COPY --from=python-packages /opt/venv /opt/venv
WORKDIR /app
COPY backend/app ./backend/app
COPY --from=web /build/frontend/dist ./web
# What the image was built from, said twice from the same two arguments so the two cannot differ: the labels, for whoever
# holds the image, and the build record, which the backend reads at start and answers on /health (app/config.py). Empty
# arguments are null in the record: the release is not here either way, because a release tags this image without building it.
ARG SOURCE_REVISION=
ARG BUILD_DATE=
LABEL org.opencontainers.image.source="https://github.com/eneo-ai/eneo-mod-speech-to-text" \
      org.opencontainers.image.revision="$SOURCE_REVISION" \
      org.opencontainers.image.created="$BUILD_DATE"
RUN python -c "import json, sys; json.dump({'revision': sys.argv[1] or None, 'build_date': sys.argv[2] or None}, open('backend/app/build_record.json', 'w'))" "$SOURCE_REVISION" "$BUILD_DATE"
ENV PATH=/opt/venv/bin:$PATH PYTHONPATH=/app/backend STATIC_DIR=/app/web \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# Numeric, so Kubernetes' runAsNonRoot can verify it (the Helm chart's runAsUser is the same number).
USER 999:999
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3001/health', timeout=3)"
CMD ["python", "-m", "app.serve"]
