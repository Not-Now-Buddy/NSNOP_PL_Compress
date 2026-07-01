FROM node:20-slim

# Ghostscript is what actually does the PDF compression - it's what most
# "compress PDF" tools use under the hood, is free, and has no plan/quota
# limits the way a SaaS API like iLovePDF does.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ghostscript \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
