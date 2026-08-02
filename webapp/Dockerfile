# Clickwright webapp — Vite build, served by nginx, which also proxies /api to
# the backend service (see webapp/nginx.conf).
#
# Built from the REPO ROOT for symmetry with backend/Dockerfile:
#   docker build -f webapp/Dockerfile .

FROM node:20.20.2-alpine AS build
WORKDIR /app/webapp

COPY webapp/package.json webapp/package-lock.json ./
RUN npm ci

COPY webapp/ ./
# `npm run build` is tsc -b && vite build, so a type error fails the image
# rather than shipping a broken bundle.
RUN npm run build

FROM nginx:1.27-alpine
COPY webapp/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/webapp/dist /usr/share/nginx/html

EXPOSE 80
