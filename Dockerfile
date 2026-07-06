ARG BASE_IMAGE=node:22-alpine
FROM ${BASE_IMAGE}

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
COPY docs ./docs

ENV NODE_ENV=production
ENV PORT=4899
EXPOSE 4899

CMD ["node", "server/index.mjs"]
