FROM node:22-alpine

# Node as PID 1 ignores SIGTERM (the server installs no handler), so a pod
# would hang for the whole grace period before being killed.
RUN apk add --no-cache tini

WORKDIR /app
ENV NODE_ENV=production NPM_CONFIG_UPDATE_NOTIFIER=false

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY . .

USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.ts"]
