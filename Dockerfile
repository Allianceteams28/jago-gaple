# Opsional: untuk layanan yang menjalankan Docker. Arahkan volume permanen ke /data.
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=3000 DATA_FILE=/data/store.json
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
