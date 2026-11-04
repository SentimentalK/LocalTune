# syntax=docker/dockerfile:1

# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---- serve ----
FROM nginx:stable-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
# Runs as the unprivileged nginx user on port 8080 (k8s-friendly).
RUN chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx /var/run /var/log/nginx \
 && sed -i 's/^user .*;//' /etc/nginx/nginx.conf \
 && sed -i 's#pid .*;#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf
USER nginx
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
