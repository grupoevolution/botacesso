FROM node:20-alpine
RUN apk add --no-cache openssl openssl-dev libc6-compat
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN mkdir -p public
EXPOSE 3000
CMD sh -c "npx prisma db push --accept-data-loss && node src/server.js"
