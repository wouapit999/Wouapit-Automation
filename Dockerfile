FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
# The SQLite database lives here; mount a volume on /app/data so it survives restarts and redeploys.
RUN mkdir -p /app/data
ENV DATABASE_PATH=/app/data/dropship.sqlite PORT=3000
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
