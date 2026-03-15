FROM ghcr.io/puppeteer/puppeteer:21.11.0

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

USER root
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.js .

EXPOSE 3000
CMD ["node", "server.js"]
