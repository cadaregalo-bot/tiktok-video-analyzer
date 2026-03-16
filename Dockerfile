FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p uploads

EXPOSE 3000

CMD ["node", "server.js"]
