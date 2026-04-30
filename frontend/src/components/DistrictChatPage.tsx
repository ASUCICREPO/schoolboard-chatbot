"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { ChatMessage } from "@/types";
import { sendChatMessage } from "@/lib/api";
import ChatMessageComponent from "./ChatMessage";
import { randomUUID } from "@/lib/uuid";
import type { DistrictMeta } from "@/lib/districts";

interface Props {
  district: DistrictMeta;
}

export default function DistrictChatPage({ district }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = useCallback(async () => {
    const query = input.trim();
    if (!query || loading) return;

    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: "user",
      content: query,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);
    setError(null);

    try {
      const response = await sendChatMessage({
        query,
        districtId: district.id,
        sessionId,
      });

      const isRefusal = /unable to assist|cannot assist|can't assist|I cannot help|I can't help/i.test(response.answer);

      const assistantMessage: ChatMessage = {
        id: randomUUID(),
        role: "assistant",
        content: response.answer,
        citations: response.citations,
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
      setSessionId(isRefusal ? undefined : response.sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      setError(msg);
      setMessages((prev) => prev.slice(0, -1));
      setInput(query);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }, [input, loading, district.id, sessionId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex flex-col h-screen" style={{ background: "var(--bg-dark)" }}>
      {/* Nav */}
      <nav
        className="flex-shrink-0 flex items-center gap-3 px-4 py-3 border-b"
        style={{ borderColor: "var(--border-subtle)", background: "#111" }}
      >
        <button
          onClick={() => router.push("/")}
          className="flex items-center justify-center w-8 h-8 rounded-lg border transition-colors"
          style={{ borderColor: "#2a2a2a", color: "#888" }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#444"; e.currentTarget.style.color = "#ccc"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#2a2a2a"; e.currentTarget.style.color = "#888"; }}
          aria-label="Back"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0"
          style={{ background: "var(--asu-maroon)", color: "white" }}
        >
          TB
        </div>

        <div className="min-w-0">
          <div className="text-sm font-semibold leading-tight truncate" style={{ color: "var(--text-primary)" }}>
            {district.name}
          </div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>
            {district.meetings} meetings indexed
          </div>
        </div>

        <div className="ml-auto">
          <a
            href="/admin"
            className="text-xs px-3 py-1.5 rounded-lg border transition-colors"
            style={{ borderColor: "#333", color: "#555" }}
          >
            Admin
          </a>
        </div>
      </nav>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-4 py-8 max-w-lg mx-auto">
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-sm"
              style={{ background: "var(--asu-maroon)" }}
            >
              AI
            </div>
            <div>
              <p className="font-semibold text-base mb-1" style={{ color: "var(--text-primary)" }}>
                Ask about {district.name}
              </p>
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                Questions are answered using {district.meetings} meeting transcripts from this district.
              </p>
            </div>

            <div className="w-full mt-2 space-y-2">
              <p className="text-xs font-medium uppercase tracking-wider mb-3" style={{ color: "#555" }}>
                Suggested questions
              </p>
              {district.faqs.map((faq) => (
                <button
                  key={faq}
                  onClick={() => setInput(faq)}
                  className="w-full text-sm text-left px-4 py-3 rounded-xl border transition-all"
                  style={{
                    background: "var(--bg-card)",
                    borderColor: "var(--border-subtle)",
                    color: "var(--text-muted)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--asu-maroon)";
                    e.currentTarget.style.color = "var(--text-primary)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border-subtle)";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  {faq}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <ChatMessageComponent key={msg.id} message={msg} />
        ))}

        {loading && (
          <div className="flex gap-3 justify-start">
            <div
              className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold"
              style={{ background: "var(--asu-maroon)" }}
            >
              AI
            </div>
            <div className="rounded-2xl rounded-bl-sm px-4 py-3" style={{ background: "var(--bg-card)" }}>
              <div className="flex gap-1 items-center h-4">
                <span className="w-2 h-2 rounded-full animate-bounce [animation-delay:0ms]" style={{ background: "#555" }} />
                <span className="w-2 h-2 rounded-full animate-bounce [animation-delay:150ms]" style={{ background: "#555" }} />
                <span className="w-2 h-2 rounded-full animate-bounce [animation-delay:300ms]" style={{ background: "#555" }} />
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Error */}
      {error && (
        <div className="mx-4 mb-2 px-3 py-2 rounded-lg text-sm" style={{ background: "rgba(140,29,64,0.15)", border: "1px solid rgba(140,29,64,0.4)", color: "#f87171" }}>
          {error}
        </div>
      )}

      {/* Input */}
      <div className="flex-shrink-0 px-4 py-3 border-t" style={{ borderColor: "var(--border-subtle)", background: "#111" }}>
        <div className="flex gap-2 items-end max-w-3xl mx-auto">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Ask about ${district.name} meetings…`}
            rows={1}
            className="flex-1 resize-none rounded-xl px-4 py-2.5 text-sm outline-none transition-all max-h-32 overflow-y-auto"
            style={{
              minHeight: "42px",
              background: "var(--bg-card)",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-primary)",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--asu-maroon)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-subtle)"; }}
            disabled={loading}
          />
          <button
            onClick={handleSubmit}
            disabled={!input.trim() || loading}
            className="flex-shrink-0 rounded-xl px-4 py-2.5 text-sm font-medium text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: "var(--asu-maroon)" }}
            onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = "var(--asu-maroon-dark)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--asu-maroon)"; }}
          >
            Send
          </button>
        </div>
        <p className="mt-1.5 text-xs text-center max-w-3xl mx-auto" style={{ color: "#444" }}>
          Answers are based on meeting transcripts and may not be complete.
        </p>
      </div>
    </div>
  );
}
