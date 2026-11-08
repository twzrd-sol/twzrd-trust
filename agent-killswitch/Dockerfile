# syntax=docker/dockerfile:1

FROM node:24-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json config.example.yaml ./
COPY src ./src
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
ENV KILLSWITCH_HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY config.example.yaml ./config.example.yaml
RUN mkdir -p /app/data
EXPOSE 4020
CMD ["node", "dist/index.js", "/app/config.yaml"]
