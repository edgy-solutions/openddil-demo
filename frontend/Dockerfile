# Stage 1: Build the React application
FROM node:20-slim AS builder

WORKDIR /app

# Build-time URL the browser will use to reach the ElectricSQL shape API.
# Vite bakes import.meta.env.VITE_ELECTRIC_URL into the bundle at build
# time — there is no runtime override (Vite is a build-time framework).
#
# Default: /electric/v1/shape — a relative path. Works on k8s where the
# Helm Ingress routes /electric/* to the in-cluster electric-sync service
# (and on any deployment where the frontend's own nginx proxies /electric/
# to electric-sync, see nginx.conf). Same-origin, no CORS.
#
# docker-compose dev path overrides this with the host-port-direct URL
# (http://localhost:5133/v1/shape) via --build-arg in docker-compose.
# override.yml, preserving the prior "browser reaches electric-sync
# directly on the host port" behavior for local dev.
ARG VITE_ELECTRIC_URL=/electric/v1/shape
ENV VITE_ELECTRIC_URL=$VITE_ELECTRIC_URL

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --legacy-peer-deps || npm install --legacy-peer-deps

# Copy source code and build
COPY . .
RUN npm run build

# Stage 2: Serve the application with Nginx
FROM nginx:alpine AS production

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Expose port 80
EXPOSE 80

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]