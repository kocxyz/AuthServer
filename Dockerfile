FROM node:24-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN apt update && apt install -y openssl curl
RUN npm install
RUN npx prisma generate
RUN npx tsc

COPY . .

EXPOSE 23501

CMD ["node", "dist/index.js"]