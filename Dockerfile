# Estágio de build: o better-sqlite3 pode precisar compilar (sem binário pronto para a versão do Node)
FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
# heif-convert: o sharp pré-compilado não decodifica HEIC
RUN apt-get update && apt-get install -y --no-install-recommends libheif-examples ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json package-lock.json server.js ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
ENV NODE_ENV=production DIR_DADOS=/dados PORT=3000
RUN mkdir -p /dados && chown node:node /dados
EXPOSE 3000
USER node
HEALTHCHECK --interval=1m --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/login.html').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
