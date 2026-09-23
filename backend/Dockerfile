FROM python:3.12-slim

WORKDIR /app

RUN groupadd --system module \
    && useradd --system --gid module --home-dir /app module

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=module:module app ./app

EXPOSE 8000
USER module

# Callback-queryn innehåller en kortlivad login-ticket. Uvicorns accesslogg
# stängs därför av så att ticket/state aldrig hamnar i containerloggar.
# WebSocket-gränserna är desamma som i deploy/supervisord.conf.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--ws-max-size", "131072", "--ws-max-queue", "16"]
