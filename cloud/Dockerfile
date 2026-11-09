FROM node:22-alpine
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY migrations ./migrations
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production
USER node
EXPOSE 8092
CMD ["node", "src/main.mjs"]
