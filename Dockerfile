# Multi-stage build for the registry-compatible stdio server. Cloud Run
# explicitly overrides MCP_TRANSPORT_MODE=http in its deployment contract.

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS build
WORKDIR /app

RUN npm install --global --ignore-scripts npm@11.15.0 \
    && test "$(npm --version)" = "11.15.0"

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS runtime
WORKDIR /app

LABEL io.modelcontextprotocol.server.name="io.github.VectorMethods/videovector-mcp-server"

RUN npm install --global --ignore-scripts npm@11.15.0 \
    && test "$(npm --version)" = "11.15.0"

ENV NODE_ENV=production
ENV PORT=8080
ENV MCP_TRANSPORT_MODE=stdio

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN chown -R node:node /app
USER node

EXPOSE 8080

ENTRYPOINT []
CMD ["node", "dist/index.js"]
