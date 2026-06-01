import { useState, useRef, useEffect } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface HistoryTurn {
  id: string;
  question: string;
  answer: string;
  timestamp: number;
  toolsUsed: string[];
}

interface Message {
  role: "user" | "agent";
  text: string;
}

interface ReasoningStep {
  id: string;
  type: "think" | "tool_call" | "tool_result" | "observe" | "respond";
  title: string;
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  timestamp: number;
}

interface ActiveStream {
  question: string;
  steps: ReasoningStep[];
  tools: string[];
  activeTool: { name: string; status: string } | null;
  finalAnswer: string;
  isComplete: boolean;
  error: { type: string; message: string; details?: string } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream hook — connects to SSE and handles ReAct reasoning events
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// SessionId — persisted in localStorage so history survives page refresh
// ─────────────────────────────────────────────────────────────────────────────

function getOrCreateSessionId(): string {
  const key = "agent_session_id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(key, id);
  return id;
}

const SESSION_ID = getOrCreateSessionId();

type LLMProvider = "openai" | "gemini";
type AgentFramework = "strands" | "crewai";

const PROVIDER_META: Record<LLMProvider, { label: string; icon: string; color: string }> = {
  openai: { label: "GPT-4o",     icon: "✦", color: "#10a37f" },
  gemini: { label: "Gemini 2.5", icon: "✦", color: "#4285f4" },
};

const FRAMEWORK_META: Record<AgentFramework, { label: string; icon: string; color: string; description: string }> = {
  strands: { label: "AWS Strands", icon: "⚡", color: "#ff9900", description: "AWS Strands SDK — full ReAct loop with MCP tools (default)" },
  crewai:  { label: "CrewAI",      icon: "🐝", color: "#d946ef", description: "CrewAI — two-agent crew: Researcher + Senior Analyst" },
};

function useAgentStream() {
  const [activeStream, setActiveStream] = useState<ActiveStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);

  const startStream = (question: string, provider: LLMProvider = "openai", framework: AgentFramework = "strands") => {
    // Abort any existing stream
    abortRef.current?.();
    setError(null);

    const newStream: ActiveStream = {
      question,
      steps: [],
      tools: [],
      activeTool: null,
      finalAnswer: "",
      isComplete: false,
      error: null,
    };
    setActiveStream(newStream);

    const controller = new AbortController();
    abortRef.current = () => controller.abort();

    const endpoint = framework === "crewai" ? "/api/stream-crewai" : "/api/stream";
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, sessionId: SESSION_ID, provider }),
      signal: controller.signal,
    }).then(async (res) => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Stream failed" }));
        throw new Error(err.error ?? "Stream failed");
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const chunk of lines) {
          const event = parseSSEChunk(chunk);
          if (event) {
            handleStreamEvent(event, setActiveStream);
          }
        }
      }
    }).catch((err) => {
      if (err.name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Stream error");
      }
    });

    return () => {
      abortRef.current?.();
    };
  };

  const clearStream = () => {
    abortRef.current?.();
    setActiveStream(null);
    setError(null);
  };

  return { activeStream, error, startStream, clearStream };
}

function HeaderDropdown<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  accentColor,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; icon: string }[];
  onChange: (v: T) => void;
  disabled: boolean;
  accentColor: string;
}) {
  return (
    <div className="header-dropdown">
      <span className="header-dropdown-label">{label}</span>
      <div className="header-dropdown-wrap" style={{ borderColor: accentColor }}>
        <span className="header-dropdown-icon">
          {options.find((o) => o.value === value)?.icon}
        </span>
        <select
          className="header-dropdown-select"
          value={value}
          onChange={(e) => onChange(e.target.value as T)}
          disabled={disabled}
          style={{ color: accentColor }}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="header-dropdown-caret" style={{ color: accentColor }}>▾</span>
      </div>
    </div>
  );
}

function parseSSEChunk(chunk: string): { event: string; data: unknown } | null {
  const lines = chunk.split("\n");
  let event = "message";
  let dataStr = "";

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      event = line.slice(7);
    } else if (line.startsWith("data: ")) {
      dataStr = line.slice(6);
    }
  }

  if (!dataStr) return null;

  try {
    return { event, data: JSON.parse(dataStr) };
  } catch {
    return { event, data: dataStr };
  }
}

function handleStreamEvent(
  { event, data }: { event: string; data: unknown },
  setStream: React.Dispatch<React.SetStateAction<ActiveStream | null>>
) {
  setStream((prev) => {
    if (!prev) return prev;

    const d = data as Record<string, unknown>;

    switch (event) {
      case "thinking":
        return {
          ...prev,
          steps: [
            ...prev.steps,
            {
              id: crypto.randomUUID(),
              type: "think",
              title: d.message as string || "🧠 Thinking...",
              timestamp: Date.now(),
            },
          ],
        };

      case "tools_list":
        return {
          ...prev,
          tools: d.tools as string[] || [],
          steps: [
            ...prev.steps,
            {
              id: crypto.randomUUID(),
              type: "think",
              title: `📦 Available tools: ${(d.tools as string[] || []).join(", ")}`,
              timestamp: Date.now(),
            },
          ],
        };

      case "active_tool":
        return {
          ...prev,
          activeTool: {
            name: d.name as string,
            status: d.status as string,
          },
          steps: [
            ...prev.steps,
            {
              id: crypto.randomUUID(),
              type: "tool_call",
              title: d.message as string || `🔧 Executing tool: ${d.name}`,
              toolName: d.name as string,
              timestamp: Date.now(),
            },
          ],
        };

      case "tool_call":
        return {
          ...prev,
          steps: [
            ...prev.steps,
            {
              id: crypto.randomUUID(),
              type: "tool_call",
              title: `🔧 Calling tool: ${d.name}`,
              toolName: d.name as string,
              toolInput: d.input,
              timestamp: Date.now(),
            },
          ],
        };

      case "tool_result":
        return {
          ...prev,
          activeTool: null, // Clear active tool when done
          steps: prev.steps.map((step, i) =>
            i === prev.steps.length - 1 && step.type === "tool_call"
              ? { ...step, toolResult: d.result }
              : step
          ),
        };

      case "text_delta":
      case "text":
        return {
          ...prev,
          finalAnswer: prev.finalAnswer + (d.text || ""),
        };

      case "final":
        // Only mark as success if no error and success flag is true
        if (d.success) {
          return {
            ...prev,
            finalAnswer: d.answer as string || prev.finalAnswer,
            isComplete: true,
            error: null,
          };
        }
        return prev;

      case "cache_hit":
        return {
          ...prev,
          steps: [
            ...prev.steps,
            {
              id: crypto.randomUUID(),
              type: "think",
              title: "⚡ Cache hit — returning cached answer",
              timestamp: Date.now(),
            },
          ],
          finalAnswer: d.answer as string || "",
          isComplete: true,
        };

      case "error":
        return {
          ...prev,
          error: {
            type: d.type as string,
            message: d.message as string,
            details: d.details as string | undefined,
          },
          isComplete: true,
        };

      default:
        return prev;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Components
// ─────────────────────────────────────────────────────────────────────────────

function ReasoningPanel({ steps, tools, activeTool, finalAnswer, isComplete, error }: ActiveStream) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [steps, finalAnswer, error]);

  return (
    <div className="reasoning-panel">
      <div className="steps">
        {steps.map((step) => (
          <div key={step.id} className={`step ${step.type}`}>
            <div className="step-header">
              <span className="step-icon">
                {step.type === "think" && "🧠"}
                {step.type === "tool_call" && "🔧"}
                {step.type === "tool_result" && "📊"}
                {step.type === "observe" && "👁"}
                {step.type === "respond" && "💬"}
              </span>
              <span className="step-title">{step.title}</span>
            </div>
            {Boolean(step.toolInput) && (
              <div className="step-detail">
                <code>{JSON.stringify(step.toolInput, null, 2)}</code>
              </div>
            )}
            {Boolean(step.toolResult) && (
              <div className="step-detail result">
                <strong>Result:</strong>
                <code>{String(JSON.stringify(step.toolResult, null, 2)).slice(0, 200)}...</code>
              </div>
            )}
          </div>
        ))}
        {/* Tools List */}
        {tools.length > 0 && (
          <div className="tools-section">
            <div className="tools-header">🛠️ Tools available:</div>
            <div className="tools-list">
              {tools.map((tool, i) => (
                <span key={i} className={`tool-tag ${activeTool?.name === tool ? 'active' : ''}`}>
                  {tool}
                  {activeTool?.name === tool && <span className="tool-pulse" />}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Active Tool - Prominent display */}
        {activeTool && (
          <div className="active-tool-banner">
            <span className="active-tool-icon">🔧</span>
            <span className="active-tool-text">
              Currently executing: <strong>{activeTool.name}</strong>
            </span>
            <span className="active-tool-spinner" />
          </div>
        )}

        {/* Loading state */}
        {!isComplete && !activeTool && (
          <div className="step loading">
            <span className="pulse-dot" />
            <span>🧠 Thinking...</span>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="step error">
            <span className="step-icon">❌</span>
            <span className="step-title">{error.message}</span>
            {error.details && (
              <div className="step-detail error-details">
                <code>{error.details}</code>
              </div>
            )}
          </div>
        )}

        {/* Request processed message - only on success */}
        {isComplete && !error && (
          <div className="step complete">
            <span className="step-icon">✅</span>
            <span className="step-title">Request processed successfully</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <div className="final-answer error">
          <div className="answer-header">
            <span>❌ Request failed</span>
          </div>
          <div className="answer-content">{error.message}</div>
        </div>
      )}

      {!error && finalAnswer && (
        <div className={`final-answer ${isComplete ? "complete" : "streaming"}`}>
          <div className="answer-header">
            <span>{isComplete ? "✅ Request processed — Final Answer" : "📝 Generating response..."}</span>
          </div>
          <div className="answer-content">{finalAnswer}</div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// History Panel
// ─────────────────────────────────────────────────────────────────────────────

function HistoryPanel({ onClose, onSelect }: { onClose: () => void; onSelect: (q: string) => void }) {
  const [turns, setTurns] = useState<HistoryTurn[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/history/${SESSION_ID}`)
      .then((r) => r.json())
      .then((data) => { setTurns(data.turns ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="history-overlay" onClick={onClose}>
      <div className="history-panel" onClick={(e) => e.stopPropagation()}>
        <div className="history-header">
          <span>💬 Session History</span>
          <button className="history-close" onClick={onClose}>✕</button>
        </div>
        <div className="history-body">
          {loading && <div className="history-empty">Loading…</div>}
          {!loading && turns.length === 0 && (
            <div className="history-empty">No history yet. Ask a question to get started.</div>
          )}
          {turns.map((turn) => (
            <div key={turn.id} className="history-turn" onClick={() => { onSelect(turn.question); onClose(); }}>
              <div className="history-question">❓ {turn.question}</div>
              <div className="history-answer">{turn.answer.slice(0, 160)}{turn.answer.length > 160 ? "…" : ""}</div>
              <div className="history-meta">
                {turn.toolsUsed.length > 0 && <span className="history-tools">🔧 {turn.toolsUsed.join(", ")}</span>}
                <span className="history-time">{new Date(turn.timestamp).toLocaleTimeString()}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [provider, setProvider] = useState<LLMProvider>("openai");
  const [framework, setFramework] = useState<AgentFramework>("strands");
  const [showHistory, setShowHistory] = useState(false);
  const { activeStream, error, startStream, clearStream } = useAgentStream();
  const bottomRef = useRef<HTMLDivElement>(null);

  const isStreaming = !!activeStream && !activeStream.isComplete;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeStream]);

  const submit = () => {
    const question = input.trim();
    if (!question || isStreaming) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", text: question }]);
    startStream(question, provider, framework);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // When stream completes, add final message to history (only on success, not error)
  useEffect(() => {
    if (activeStream?.isComplete && !activeStream.error && activeStream.finalAnswer) {
      setMessages((prev) => [
        ...prev.filter((m) => m.role !== "agent" || m.text !== activeStream.finalAnswer),
        { role: "agent", text: activeStream.finalAnswer },
      ]);
      clearStream();
    }
  }, [activeStream?.isComplete, activeStream?.error, activeStream?.finalAnswer]);

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <span className="logo">⚡</span>
          <div>
            <h1>CORE ENGINEERING R&D - AI Stock Agent</h1>
            <p className="subtitle">Powered by Core Engineering R&D - AI</p>
          </div>
          <div className="header-controls">
            <HeaderDropdown<AgentFramework>
              label="Framework"
              value={framework}
              options={[
                { value: "strands", label: "AWS Strands", icon: "⚡" },
                { value: "crewai",  label: "CrewAI",      icon: "🐝" },
              ]}
              onChange={setFramework}
              disabled={isStreaming}
              accentColor={FRAMEWORK_META[framework].color}
            />
            <HeaderDropdown<LLMProvider>
              label="Model"
              value={provider}
              options={[
                { value: "openai", label: "GPT-4o",     icon: "✦" },
                { value: "gemini", label: "Gemini 2.5", icon: "✦" },
              ]}
              onChange={setProvider}
              disabled={isStreaming}
              accentColor={PROVIDER_META[provider].color}
            />
            <button
              className="history-icon-btn"
              title="View session history"
              onClick={() => setShowHistory(true)}
            >
              📜
            </button>
          </div>
        </div>
      </header>

      {showHistory && (
        <HistoryPanel
          onClose={() => setShowHistory(false)}
          onSelect={(q) => setInput(q)}
        />
      )}

      <main className="chat-container">
        {messages.length === 0 && !activeStream && (
          <div className="empty-state">
            <p>Your AI-powered NASDAQ market analyst — live prices, insider trades, and technical analysis, all in one conversation.</p>
            <ul>
              <li>Try: <em>"What is the technical analysis for NVDA?"</em></li>
              <li>Try: <em>"Who has been selling TSLA stock recently?"</em></li>
              <li>Try: <em>"Is AAPL overbought? Show RSI and moving averages."</em></li>
              <li>Try: <em>"Compare the 52-week range of MSFT and AMZN."</em></li>
            </ul>
            <p className="react-info">
              Watch the ReAct reasoning panel to see live tool calls, NASDAQ data fetches, and AI analysis in real time!
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            <span className="avatar">{msg.role === "user" ? "You" : "Agent"}</span>
            <div className="bubble">
              {msg.text.split("\n").map((line, j) => (
                <span key={j}>
                  {line}
                  {j < msg.text.split("\n").length - 1 && <br />}
                </span>
              ))}
            </div>
          </div>
        ))}

        {activeStream && (
          <div className="message agent streaming">
            <span className="avatar">Agent</span>
            <div className="bubble reasoning-bubble">
              <ReasoningPanel {...activeStream} />
            </div>
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}

        <div ref={bottomRef} />
      </main>

      <footer className="input-bar">
        <div className="input-wrapper">
          <textarea
            className="input-field"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Ask a question… (Enter to send, Shift+Enter for new line)"
            rows={2}
            disabled={isStreaming}
          />
        </div>
        <button
          className="send-btn"
          onClick={submit}
          disabled={isStreaming || !input.trim()}
        >
          {isStreaming ? "…" : "Send"}
        </button>
      </footer>
    </div>
  );
}
