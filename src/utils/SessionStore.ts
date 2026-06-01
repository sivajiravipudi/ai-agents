/**
 * SessionStore — per-session Agent instances with persistent conversation history.
 *
 * Each sessionId maps to its own Agent instance. The agent's internal
 * messages array accumulates the full conversation across multiple questions,
 * giving the LLM context of prior turns within the session.
 *
 * Sessions expire after SESSION_TTL_MS of inactivity (default 30 minutes).
 */

import type { Agent } from "@strands-agents/sdk";

export interface Turn {
  id: string;
  question: string;
  answer: string;
  timestamp: number;
  toolsUsed: string[];
}

export interface Session {
  agent: Agent;
  turns: Turn[];
  lastActive: number;
}

const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS ?? "1800000", 10); // 30 min

class SessionStore {
  private sessions = new Map<string, Session>();

  get(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    // Expire stale sessions
    if (Date.now() - session.lastActive > SESSION_TTL_MS) {
      this.sessions.delete(sessionId);
      return undefined;
    }

    session.lastActive = Date.now();
    return session;
  }

  set(sessionId: string, agent: Agent): Session {
    const session: Session = { agent, turns: [], lastActive: Date.now() };
    this.sessions.set(sessionId, session);
    return session;
  }

  addTurn(sessionId: string, turn: Omit<Turn, "id">): Turn {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const full: Turn = { id: crypto.randomUUID(), ...turn };
    session.turns.push(full);
    session.lastActive = Date.now();
    return full;
  }

  getHistory(sessionId: string): Turn[] {
    return this.sessions.get(sessionId)?.turns ?? [];
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  activeCount(): number {
    return this.sessions.size;
  }

  /** Prune expired sessions — called periodically. */
  prune(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActive > SESSION_TTL_MS) {
        this.sessions.delete(id);
      }
    }
  }
}

export const sessionStore = new SessionStore();

// Prune every 10 minutes
setInterval(() => sessionStore.prune(), 600_000);
