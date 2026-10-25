# Multi-stage or lightweight Python 3.11 container for NPC Service
FROM python:3.11-slim

WORKDIR /app

# Set environment variables for Python performance & non-interactive behavior
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# RDS enforces TLS; tasks run without internet access, so the CA bundle ships in the image.
RUN python -c "import urllib.request; urllib.request.urlretrieve('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem', '/app/rds-ca.pem')"

# Copy source code
COPY src/ ./src/

# Default runtime configuration
ENV WORLD_WS_URL="ws://world-service:8001" \
    BOT_NAME_PREFIX="[NPC] Guardian" \
    BOT_COUNT=2 \
    DECISION_TICK_RATE_HZ=10 \
    RECONNECT_DELAY_SECONDS=3

CMD ["python", "src/main.py"]
