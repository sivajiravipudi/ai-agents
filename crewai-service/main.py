"""
CrewAI Stock Analyst Microservice
==================================
Runs a two-agent CrewAI crew on port 3003:
  - Researcher  → fetches live NASDAQ data via the NASDAQ MCP HTTP tools
  - Analyst     → synthesises the raw data into a structured investment summary

Endpoints:
  GET  /health            → liveness check
  POST /stream            → SSE stream of crew step events + final answer
  POST /ask               → single-turn JSON response (no streaming)
"""

from __future__ import annotations

import json
import os
import time
from typing import Generator

import requests
from crewai import Agent, Crew, Process, Task
from crewai.tools import tool
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL   = os.getenv("OPENAI_MODEL", "gpt-4o")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")
GOOGLE_MODEL   = os.getenv("GOOGLE_MODEL", "gemini-2.5-flash")
NASDAQ_MCP_URL = os.getenv("NASDAQ_MCP_URL", "http://localhost:3002/mcp")

os.environ["OPENAI_API_KEY"] = OPENAI_API_KEY
if GOOGLE_API_KEY:
    os.environ["GOOGLE_API_KEY"] = GOOGLE_API_KEY


def resolve_llm(provider: str) -> str:
    """Return the CrewAI LLM string for the given provider name."""
    if provider == "gemini":
        return f"gemini/{GOOGLE_MODEL}"
    return f"openai/{OPENAI_MODEL}"

app = FastAPI(title="CrewAI Stock Analyst", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────────────────────────────────────
# MCP Tool wrappers — call the NASDAQ MCP HTTP server directly via JSON-RPC
# ─────────────────────────────────────────────────────────────────────────────

_mcp_session_id: str | None = None


def _mcp_call(tool_name: str, arguments: dict) -> str:
    """Send a JSON-RPC tools/call to the NASDAQ MCP server."""
    global _mcp_session_id
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if _mcp_session_id:
        headers["mcp-session-id"] = _mcp_session_id

    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments},
    }

    try:
        resp = requests.post(NASDAQ_MCP_URL, json=payload, headers=headers, timeout=30)
        # Capture session ID from response header for session reuse
        if "mcp-session-id" in resp.headers:
            _mcp_session_id = resp.headers["mcp-session-id"]
        data = resp.json()
        result = data.get("result", {})
        content = result.get("content", [])
        return "\n".join(c.get("text", "") for c in content if c.get("type") == "text")
    except Exception as exc:
        return f"MCP tool error: {exc}"


@tool("get_nasdaq_stock_data")
def get_nasdaq_stock_data(symbol: str) -> str:
    """Fetch live price, volume, 52-week range, PE ratio, EPS, dividends,
    and recent insider transactions for a NASDAQ-listed stock symbol."""
    return _mcp_call("get_nasdaq_stock_data", {"symbol": symbol.upper()})


@tool("get_technical_analysis")
def get_technical_analysis(symbol: str) -> str:
    """Compute SMA-20/50/200, EMA-20, RSI-14, support/resistance levels,
    trend direction, and volume trend for a stock using 1 year of OHLCV data."""
    return _mcp_call("get_technical_analysis", {"symbol": symbol.upper()})


@tool("search_nasdaq_ticker")
def search_nasdaq_ticker(company_name: str) -> str:
    """Look up the NASDAQ ticker symbol for a company by its name."""
    return _mcp_call("search_nasdaq_ticker", {"query": company_name})


NASDAQ_TOOLS = [get_nasdaq_stock_data, get_technical_analysis, search_nasdaq_ticker]

# ─────────────────────────────────────────────────────────────────────────────
# CrewAI Agents
# ─────────────────────────────────────────────────────────────────────────────

def build_crew_agents(provider: str) -> tuple[Agent, Agent]:
    """Construct researcher and analyst agents for the given LLM provider."""
    llm = resolve_llm(provider)

    researcher = Agent(
        role="NASDAQ Market Researcher",
        goal=(
            "Gather all available real-time data for the requested stock(s): "
            "price, fundamentals, insider transactions, and technical indicators."
        ),
        backstory=(
            "You are a quantitative data specialist with direct access to NASDAQ's "
            "live API. You extract structured market data accurately and completely, "
            "citing every number you fetch."
        ),
        tools=NASDAQ_TOOLS,
        llm=llm,
        verbose=True,
        max_iter=6,
    )

    analyst = Agent(
        role="Senior Investment Analyst",
        goal=(
            "Synthesise raw market data into a concise, actionable investment summary "
            "covering price trend, technical stance, valuation, and insider sentiment."
        ),
        backstory=(
            "You are a CFA-level analyst who turns raw market data into clear, "
            "structured investment perspectives. You always cite specific numbers "
            "and avoid speculation beyond the provided data."
        ),
        tools=[],
        llm=llm,
        verbose=True,
    )

    return researcher, analyst


# ─────────────────────────────────────────────────────────────────────────────
# Build and run a crew for a given question
# ─────────────────────────────────────────────────────────────────────────────

def run_crew(question: str, provider: str = "openai") -> Generator[str, None, None]:
    """Run the crew and yield SSE-formatted events."""

    def sse(event: str, data: dict) -> str:
        return f"event: {event}\ndata: {json.dumps(data)}\n\n"

    llm_label = f"Gemini ({GOOGLE_MODEL})" if provider == "gemini" else f"OpenAI ({OPENAI_MODEL})"
    yield sse("thinking", {"message": f"🤖 CrewAI crew initialising — 2 agents using {llm_label}"})

    researcher, analyst = build_crew_agents(provider)

    research_task = Task(
        description=(
            f"User question: {question}\n\n"
            "Fetch all relevant NASDAQ data needed to answer this question. "
            "Use get_nasdaq_stock_data for price/fundamentals/insider trades, "
            "get_technical_analysis for chart indicators, and search_nasdaq_ticker "
            "if the ticker is unknown. Return ALL raw data with exact numbers."
        ),
        expected_output=(
            "A structured data report with all fetched figures: price, change, "
            "volume, PE ratio, EPS, 52-week range, RSI, SMAs, insider transactions."
        ),
        agent=researcher,
    )

    analysis_task = Task(
        description=(
            "Using the research data provided, synthesise a clear investment summary "
            "that directly answers the user's original question. "
            "Structure: Price & Trend | Technical Analysis | Valuation | Insider Activity | Verdict."
        ),
        expected_output=(
            "A structured, factual investment summary answering the user question "
            "with cited numbers, no hallucinations, and a final verdict sentence."
        ),
        agent=analyst,
        context=[research_task],
    )

    crew = Crew(
        agents=[researcher, analyst],
        tasks=[research_task, analysis_task],
        process=Process.sequential,
        verbose=False,
    )


    yield sse("tool_call", {"name": "crewai_crew", "input": {"agents": ["NASDAQ Market Researcher", "Senior Investment Analyst"]}})

    try:
        result = crew.kickoff()
        final = str(result.raw) if hasattr(result, "raw") else str(result)
        yield sse("tool_result", {"name": "crewai_crew", "result": f"Crew completed ({len(final)} chars)"})
        yield sse("final", {"answer": final, "success": True})
    except Exception as exc:
        yield sse("error", {"type": "general", "message": f"❌ CrewAI error: {exc}", "details": str(exc)})

    yield sse("done", {})


# ─────────────────────────────────────────────────────────────────────────────
# FastAPI routes
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "crewai-stock-analyst"}


@app.post("/stream")
async def stream(body: dict) -> StreamingResponse:
    question = (body.get("question") or "").strip()
    provider = (body.get("provider") or "openai").strip()
    if not question:
        return JSONResponse({"error": "Field 'question' is required."}, status_code=400)

    return StreamingResponse(
        run_crew(question, provider),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/ask")
async def ask(body: dict) -> dict:
    question = (body.get("question") or "").strip()
    provider = (body.get("provider") or "openai").strip()
    if not question:
        return JSONResponse({"error": "Field 'question' is required."}, status_code=400)

    events = list(run_crew(question, provider))
    for raw in reversed(events):
        for line in raw.split("\n"):
            if line.startswith("data: "):
                try:
                    d = json.loads(line[6:])
                    if d.get("success") and d.get("answer"):
                        return {"answer": d["answer"]}
                except Exception:
                    pass
    return {"answer": "No answer generated."}
