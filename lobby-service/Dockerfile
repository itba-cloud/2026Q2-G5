FROM node:22-alpine

WORKDIR /app

# Install dependencies first for Docker layer caching
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# Pin the public RDS CA bundle; validate TLS in the worker rather than no-verify.
RUN mkdir -p certs && wget -q https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -O certs/rds-ca.pem \
    && echo "90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b  certs/rds-ca.pem" | sha256sum -c -
COPY src ./src

# Expose default lobby API port
EXPOSE 3000

# Run the lobby service
CMD ["node", "src/index.js"]

