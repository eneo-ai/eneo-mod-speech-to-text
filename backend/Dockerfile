FROM python:3.12-slim

WORKDIR /app

RUN groupadd --system module \
    && useradd --system --gid module --home-dir /app module

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=module:module app ./app

EXPOSE 8000
USER module

# Backend startas av startprogrammet (app/serve.py), som ensam sätter en arbetsprocess, ingen accesslogg (callback-queryn
# innehåller en kortlivad login-ticket) och WebSocket-gränserna i app/limits.py, samma som i deploy/supervisord.conf.
CMD ["python", "-m", "app.serve", "--api-only", "--port", "8000"]
