FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY *.ts ./
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY index.html app.js styles.css usage.css ./public/
COPY 001_init.sql ./migrations/001_init.sql
EXPOSE 3000
CMD ["node", "dist/server.js"]
