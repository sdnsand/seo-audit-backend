# USE NODE 20 (Crucial for the new libraries)
FROM node:20-slim

# Install Google Chrome Stable and fonts
# This is required for Puppeteer to work on Linux (Render)
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set up the App Directory
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
# We add --legacy-peer-deps to prevent strict dependency errors during build
RUN npm install --legacy-peer-deps

# Copy the rest of your app code
COPY . .

# Expose the port
EXPOSE 5000

# Start the server
CMD [ "node", "server.js" ]