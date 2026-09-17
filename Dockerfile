FROM node:18-alpine
# Устанавливаем системные зависимости для сборки бинарных модулей (например, sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
