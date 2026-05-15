"""
code_exec_tool_server.py - FastAPI wrapper around the Piston code execution API.

GET  /         - tool discovery (OpenAI function-schema list)
POST /         - execute a named tool call, return result as JSON
GET  /health   - liveness check

Env vars:
  PISTON_URL          (default: http://piston:2000)
  RUN_TIMEOUT_MS      (default: 30000)
  COMPILE_TIMEOUT_MS  (default: 10000)
"""
from __future__ import annotations
import logging
import os
from typing import Any
import httpx
import pydantic
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

PISTON_URL = os.getenv("PISTON_URL", "http://piston:2000")
RUN_TIMEOUT_MS = int(os.getenv("RUN_TIMEOUT_MS", "30000"))
COMPILE_TIMEOUT_MS = int(os.getenv("COMPILE_TIMEOUT_MS", "10000"))
HTTP_TIMEOUT = (RUN_TIMEOUT_MS + COMPILE_TIMEOUT_MS) / 1000 + 5

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

LANGUAGE_FILENAMES = {
    "bash": "main.sh", "c": "main.c", "c++": "main.cpp", "go": "main.go",
    "java": "Main.java", "javascript": "main.js", "lua": "main.lua",
    "perl": "main.pl", "php": "main.php", "python": "main.py",
    "r": "main.r", "ruby": "main.rb", "rust": "main.rs",
    "swift": "main.swift", "typescript": "main.ts",
}

def _filename_for(language: str) -> str:
    return LANGUAGE_FILENAMES.get(language.lower(), "main")

TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "run_code",
            "description": (
                "Execute source code in any programming language supported by Piston. "
                "Call list_runtimes first to see what is installed. "
                "Returns: language, version, status, exit_code, output, stderr."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "language": {
                        "type": "string",
                        "description": "Language name e.g. python, javascript, rust, go, java, c, c++, bash. Call list_runtimes for full list.",
                    },
                    "code": {"type": "string", "description": "Source code to execute."},
                    "version": {"type": "string", "description": "Runtime version. Use * for latest.", "default": "*"},
                    "stdin": {"type": "string", "description": "Optional stdin text.", "default": ""},
                },
                "required": ["language", "code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_runtimes",
            "description": "List all language runtimes installed in the Piston sandbox. Returns language, version, aliases.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
]

class ToolCallRequest(pydantic.BaseModel):
    name: str
    parameters: dict[str, Any] = {}
    arguments: dict[str, Any] = {}
    def merged_params(self) -> dict[str, Any]:
        return self.parameters or self.arguments

app = FastAPI(title="Code Execution Tool Server (Piston)", version="2.0.0")

@app.get("/")
async def list_tools():
    return JSONResponse(content=TOOL_DEFINITIONS)

@app.post("/")
async def call_tool(request: ToolCallRequest):
    params = request.merged_params()
    logger.info("Tool call: name=%s", request.name)
    async with httpx.AsyncClient(base_url=PISTON_URL, timeout=HTTP_TIMEOUT) as client:
        if request.name == "run_code":
            language = params.get("language", "").strip()
            code = params.get("code")
            if not language:
                raise HTTPException(status_code=400, detail="Missing required parameter: language")
            if code is None:
                raise HTTPException(status_code=400, detail="Missing required parameter: code")
            payload = {
                "language": language,
                "version": params.get("version", "*"),
                "files": [{"name": _filename_for(language), "content": code}],
                "stdin": params.get("stdin", ""),
                "run_timeout": RUN_TIMEOUT_MS,
                "compile_timeout": COMPILE_TIMEOUT_MS,
            }
            try:
                resp = await client.post("/api/v2/execute", json=payload)
            except httpx.RequestError as exc:
                raise HTTPException(status_code=502, detail="Piston unreachable: " + str(exc))
            if resp.status_code == 400:
                msg = resp.json().get("message", resp.text) if resp.content else resp.text
                raise HTTPException(status_code=400, detail="Piston rejected: " + msg)
            resp.raise_for_status()
            data = resp.json()
            run = data.get("run", {})
            compile_ = data.get("compile", {})
            parts = []
            if compile_.get("output", "").strip():
                parts.append("[compile]\n" + compile_["output"].strip())
            if run.get("output", "").strip():
                parts.append(run["output"].strip())
            sig = run.get("signal")
            ec = run.get("code")
            status = ("KILLED (" + sig + ")") if sig else ("OK" if ec == 0 else "ERROR")
            return JSONResponse(content={"result": {
                "language": data.get("language"),
                "version": data.get("version"),
                "status": status,
                "exit_code": ec,
                "output": "\n".join(parts),
                "stderr": run.get("stderr", "").strip(),
            }})
        elif request.name == "list_runtimes":
            try:
                resp = await client.get("/api/v2/runtimes")
            except httpx.RequestError as exc:
                raise HTTPException(status_code=502, detail="Piston unreachable: " + str(exc))
            resp.raise_for_status()
            runtimes = sorted(
                [{"language": r["language"], "version": r["version"], "aliases": r.get("aliases", [])} for r in resp.json()],
                key=lambda x: x["language"]
            )
            return JSONResponse(content={"result": runtimes})
        else:
            raise HTTPException(status_code=404, detail="Unknown tool: " + repr(request.name))

@app.get("/health")
async def health():
    return {"status": "ok"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8765, log_level="info")
