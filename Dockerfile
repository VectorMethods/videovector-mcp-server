# Multi-stage build for VideoVector MCP server (Cloud Run HTTP transport)

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime
WORKDIR /app

LABEL io.modelcontextprotocol.server.name="io.github.VectorMethods/videovector-mcp-server"

ENV NODE_ENV=production
ENV PORT=8080
ENV MCP_TRANSPORT_MODE=http

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN chown -R node:node /app
USER node

EXPOSE 8080

CMD ["node", "dist/index.js"]
