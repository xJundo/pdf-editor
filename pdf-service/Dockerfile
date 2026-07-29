FROM python:3.13-slim

# Free fonts used as fallbacks when an embedded font lacks glyphs
# (Liberation is metrically compatible with Helvetica/Times/Courier).
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-liberation fonts-noto-core fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# uid 1001 must match the app image's user: both containers share the
# pdf_files volume mounted at /data/files.
RUN useradd --create-home --uid 1001 appuser

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# Both must exist and be owned here: a named volume mounted over a missing
# directory lands root-owned, and appuser could no longer cache fonts.
RUN mkdir -p /data/files /data/fonts && chown appuser /data/files /data/fonts
USER appuser

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
