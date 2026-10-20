FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY bin ./bin

ENV BMCL_PORT=8080 \
    BMCL_HOST=0.0.0.0 \
    BMCL_CACHE_DIR=/data \
    BMCL_CACHE_MAX_BYTES=68719476736 \
    BMCL_MAX_DOWNLOADS=16

VOLUME ["/data"]
EXPOSE 8080

USER node
CMD ["node", "src/server.js"]