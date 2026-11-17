FROM python:3.12-alpine

# Create non-privileged sandbox user and group
RUN addgroup -g 1000 sandbox && \
    adduser -u 1000 -G sandbox -D -s /bin/sh sandbox

WORKDIR /app
COPY execute.py /app/execute.py

# Ensure execute.py is readable and executable
RUN chmod 755 /app/execute.py && \
    chmod 777 /tmp

USER sandbox

ENTRYPOINT ["python3", "/app/execute.py"]
