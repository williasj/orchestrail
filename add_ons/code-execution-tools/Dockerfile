# Dockerfile — code-exec-tools wrapper (Piston edition)
#
# This is a thin FastAPI service that proxies tool calls to a Piston
# code-execution container.  No gVisor or special privileges needed here —
# all sandboxing is handled by Piston.
FROM python:3.12-slim

RUN pip install --no-cache-dir \
    "fastapi>=0.110" \
    "uvicorn[standard]>=0.29" \
    "pydantic>=2.0" \
    "httpx>=0.27"

WORKDIR /app
COPY code_exec_tool_server.py ./

EXPOSE 8765

CMD ["uvicorn", "code_exec_tool_server:app", "--host", "0.0.0.0", "--port", "8765", "--log-level", "info"]