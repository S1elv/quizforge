FROM node:22-bookworm AS build
WORKDIR /app
COPY package*.json ./
COPY client/package*.json client/
COPY server/package*.json server/
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV SERVE_CLIENT=true
COPY --from=build /app /app
EXPOSE 3001
CMD ["npm","run","start"]
