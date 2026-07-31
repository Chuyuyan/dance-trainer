# Dance Trainer is a Vite app, not a folder of static files: the source
# index.html points at /src/main.tsx, which a browser will not execute. It has
# to be built first and the *built* output served — copying the repo in
# directly serves the dev entry point and renders a blank page.

# ---- Build ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Accounts are opt-in and baked in at build time. Left empty the app runs
# entirely locally with no network calls; pass it to enable practice history:
#   fly deploy --build-arg VITE_PLAYKIT_URL=https://your-playkit-host
ARG VITE_PLAYKIT_URL=""
ENV VITE_PLAYKIT_URL=$VITE_PLAYKIT_URL

RUN npm run build

# ---- Serve ----
FROM pierrezemb/gostatic
COPY --from=build /app/dist /srv/http/
CMD ["-port", "8080", "-https-promote", "-enable-logging"]
