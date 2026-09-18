FROM python:3.11-slim

# pdftotext (couche texte des PDF) et tesseract (scans et photos)
RUN apt-get update && apt-get install -y --no-install-recommends \
        poppler-utils tesseract-ocr tesseract-ocr-fra \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY data ./data
COPY tests ./tests

ENV DB_PATH=/srv/etat/chiffra.db CACHE_DIR=/srv/etat/cache
RUN mkdir -p /srv/etat

EXPOSE 8000
CMD ["uvicorn", "app.api:app", "--host", "0.0.0.0", "--port", "8000"]
