# 1. Start with a Linux machine that has Node.js installed
FROM node:18-slim

# 2. Install Google Chrome and fonts (Required for the scraper to work!)
# This block downloads Chrome and necessary font libraries so screenshots aren't broken.
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 3. Create a folder for our app inside the cloud computer
WORKDIR /usr/src/app

# 4. Copy package files first (to install libraries)
COPY package*.json ./

# 5. Install the libraries (Express, Puppeteer, etc.)
RUN npm install

# 6. Copy the rest of your code (server.js, etc.)
COPY . .

# 7. Open the door (Port 5000) so the outside world can talk to it
EXPOSE 5000

# 8. The command to start the app
CMD [ "node", "server.js" ]