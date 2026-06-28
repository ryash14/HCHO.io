FROM python:3.10-slim
WORKDIR /app
COPY . .
EXPOSE 7860
CMD ["python3", "-m", "http.server", "7860"]
