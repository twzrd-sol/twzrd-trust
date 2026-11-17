# twzrd-sentinel in a container. Build from this example's directory:
#
#   docker build -f deploy/Dockerfile -t twzrd-sentinel .
#   docker run --rm -v sentinel-state:/state twzrd-sentinel
#
# It installs @twzrd1111/mandate from npm, so it builds once that package is
# published. As written it runs loopback (no wallet, no network). For live,
# mount a mandate and append: --live --mandate /state/mandate.json
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY sentinel.mjs ./
COPY lib ./lib

RUN mkdir /state && chown node:node /state
USER node
VOLUME /state

# The control API binds 127.0.0.1 inside the container; it is not published.
ENTRYPOINT ["node", "/app/sentinel.mjs", "run", "--dir", "/state"]
CMD ["--interval", "300"]
