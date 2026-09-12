# server/ in this public mirror is static docs + .well-known only.
# twzrd-agent-intel is a private package and is not in this tree.
# Do not build or run this image here. Serve the files as static content.
FROM busybox:1.36
WORKDIR /docs
COPY . /docs
RUN echo 'server/ is static docs only; twzrd-agent-intel is not in this repo' >&2 && exit 1
