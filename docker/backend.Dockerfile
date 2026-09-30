FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 TZ=Asia/Ho_Chi_Minh
WORKDIR /app

COPY docker/backend-requirements.txt requirements.txt
RUN pip install -r requirements.txt

COPY api api
COPY backend backend

WORKDIR /app/backend
EXPOSE 8000
CMD ["python", "server.py"]
