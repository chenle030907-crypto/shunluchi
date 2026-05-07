FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY index.html styles.css app.js library-import.js server.js ./
COPY manifest.webmanifest sw.js icon.svg apple-touch-icon.png icon-512.png ./
COPY scripts ./scripts

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173

EXPOSE 4173

CMD ["node", "server.js"]
