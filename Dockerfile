FROM node:20-slim

# 1. Install Chrome dependencies (Crucial for Render)
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 2. Setup App
WORKDIR /usr/src/app

# 3. Install App Dependencies
COPY package*.json ./
# Legacy peer deps helps avoid conflicts with different Puppeteer versions
RUN npm install --legacy-peer-deps

# 4. Copy Source
COPY . .

# 5. Expose Port
EXPOSE 5000

# 6. Start
CMD [ "node", "server.js" ]
