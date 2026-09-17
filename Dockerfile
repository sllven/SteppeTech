FROM node:18-alpine

WORKDIR /app

RUN mkdir -p /data

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 3000

ENV DATA_PATH=/data/db.json

CMD ["node", "server.js"]
