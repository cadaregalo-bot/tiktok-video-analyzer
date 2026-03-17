FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .
RUN mkdir -p uploads frames
EXPOSE 3000
CMD ["node", "server.js"]
