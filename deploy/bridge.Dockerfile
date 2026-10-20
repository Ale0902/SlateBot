# Slate's bridge (server/bridge.py) and the tool server it starts, with
# the page they serve. Built by deploy/docker-compose.yml.
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY index.html styles.css ./
COPY dist dist
COPY retro retro
COPY holidays holidays
COPY server server

# Runs as an ordinary user, with the same uid as the LLM PC's own account
# so the logs it writes to the mounted logs/ folder belong to that account.
RUN useradd --uid 1000 --no-create-home slate \
    && mkdir logs charts && chown slate logs charts
USER slate

# Listens on the Docker network only (Caddy is in front of it), and reads
# visitors' addresses from the X-Forwarded-For Caddy sets.
ENV BRIDGE_HOST=0.0.0.0 \
    TRUST_PROXY=1 \
    PYTHONUNBUFFERED=1 \
    MPLCONFIGDIR=/tmp/matplotlib

CMD ["python", "server/bridge.py"]
