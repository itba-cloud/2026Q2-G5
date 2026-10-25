FROM node:22-alpine

WORKDIR /app

# Install dependencies first for Docker layer caching
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy source code
COPY . .

# Expose the metrics API port
EXPOSE 3100

# Run the metrics collector and dashboard API
CMD ["node", "src/index.js"]
