# Purser: one Node process serving the API, the participant pages and the web app.
FROM node:22.18.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm test && npm prune --omit=dev

FROM node:22.18.0-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8790 PURSER_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/main.ts"]
