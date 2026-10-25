FROM node:22-alpine

WORKDIR /app

# Install dependencies first for Docker layer caching
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy source code
COPY . .

# Expose default game server WebSocket port
EXPOSE 8001

# Run the authoritative world service
CMD ["node", "src/index.js"]
