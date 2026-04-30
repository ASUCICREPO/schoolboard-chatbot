"use client";

import type { ChatMessage as ChatMessageType } from "@/types";

interface Props {
  message: ChatMessageType;
}

export default function ChatMessage({ message }: Props) {
  const isUser = message.role === "user";

  return (
    <div className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div
          className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold"
          style={{ background: "var(--asu-maroon)" }}
        >
          AI
        </div>
      )}
      <div
        className="max-w-[80%] rounded-2xl px-4 py-3 text-sm"
        style={
          isUser
            ? { background: "var(--asu-maroon)", color: "white", borderBottomRightRadius: "4px" }
            : { background: "var(--bg-card)", color: "var(--text-primary)", borderBottomLeftRadius: "4px" }
        }
      >
        <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
        {!isUser && message.citations && message.citations.length > 0 && (
          <div className="mt-3 pt-3 border-t space-y-1" style={{ borderColor: "#2a2a2a" }}>
            <p className="text-xs font-medium uppercase tracking-wider" style={{ color: "#555" }}>Sources</p>
            {message.citations.map((c, i) => (
              <p key={i} className="text-xs" style={{ color: "#666" }}>
                {c.metadata?.title as string ?? c.location ?? `Source ${i + 1}`}
              </p>
            ))}
          </div>
        )}
      </div>
      {isUser && (
        <div
          className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
          style={{ background: "#2a2a2a", color: "#888" }}
        >
          You
        </div>
      )}
    </div>
  );
}
