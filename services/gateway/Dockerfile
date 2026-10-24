# Two stages: build the TypeScript with dev tools, then ship only the compiled JS + production deps.
# The final image has no compiler, no source and no dev dependencies, and runs as a non-root user.

# ---- 1. Build ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- 2. Run ----
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# "node" is a non-root user (uid 1000) that ships with the official Node image.
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
