# --- build stage : install + prisma generate --------------------------------
FROM node:20-alpine AS build
WORKDIR /app
# OpenSSL est requis par prisma
RUN apk add --no-cache openssl
COPY package.json ./
RUN npm install --omit=optional --no-audit --no-fund
COPY prisma ./prisma
RUN npx prisma generate
COPY src ./src

# --- runtime stage ----------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache openssl tini
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY package.json ./

ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","src/server.js"]
EXPOSE 3000
