FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip ffmpeg \
    && pip3 install yt-dlp --break-system-packages \
    && apt-get clean

ENV PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["node", "bot.js"]
