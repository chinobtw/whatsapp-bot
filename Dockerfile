FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip ffmpeg curl unzip \
    && pip3 install yt-dlp --break-system-packages \
    && curl -fsSL https://deno.land/install.sh | sh \
    && apt-get clean

ENV PATH="/root/.deno/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["node", "bot.js"]
