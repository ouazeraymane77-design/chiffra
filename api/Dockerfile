# Agents et API : Node 20, avec les outils de lecture de documents.
# Le contexte de construction est la racine du depot, pour que le jeu de
# donnees soit copie sans etre duplique dans le sous-dossier api/.
FROM node:20-bookworm-slim AS build
WORKDIR /srv
COPY api/package.json api/package-lock.json* ./
RUN npm install
COPY api/tsconfig.json ./
COPY api/src ./src
RUN npm run build

FROM node:20-bookworm-slim
# pdftotext et pdftoppm (poppler) pour la couche texte et le rendu des scans,
# tesseract pour l'OCR.
RUN apt-get update && apt-get install -y --no-install-recommends \
        poppler-utils tesseract-ocr tesseract-ocr-fra \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY api/package.json api/package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /srv/dist ./dist
COPY data ./data
ENV NODE_ENV=production DATA_DIR=/srv/data PORT=8000
EXPOSE 8000
CMD ["node", "dist/server.js"]
