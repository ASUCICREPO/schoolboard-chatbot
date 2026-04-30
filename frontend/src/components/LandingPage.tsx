"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { DISTRICTS, UPDATED_DATES } from "@/lib/districts";

export default function LandingPage() {
  const [search, setSearch] = useState("");
  const router = useRouter();

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return DISTRICTS;
    return DISTRICTS.filter((d) => d.name.toLowerCase().includes(q));
  }, [search]);

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg-dark)" }}>
      {/* Nav */}
      <nav
        className="flex items-center justify-between px-6 py-3 border-b"
        style={{ borderColor: "var(--border-subtle)", background: "#111" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold"
            style={{ background: "var(--asu-maroon)", color: "white" }}
          >
            TB
          </div>
          <div>
            <div className="text-white font-semibold text-sm leading-tight">The Beam</div>
            <div className="text-xs font-medium tracking-widest uppercase" style={{ color: "var(--asu-gold)" }}>
              School Board AI
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/admin"
            className="text-xs px-3 py-1.5 rounded-lg border transition-colors"
            style={{ borderColor: "#333", color: "#888" }}
          >
            Admin
          </a>
          <button
            className="w-8 h-8 rounded-full border flex items-center justify-center text-sm font-bold transition-colors"
            style={{ borderColor: "#333", color: "#888" }}
            title="Help"
          >
            ?
          </button>
        </div>
      </nav>

      {/* Hero */}
      <div className="flex flex-col items-center text-center px-4 pt-16 pb-10">
        <div
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-semibold mb-8 border"
          style={{
            background: "rgba(140,29,64,0.15)",
            borderColor: "rgba(140,29,64,0.4)",
            color: "var(--asu-gold)",
          }}
        >
          <span style={{ color: "var(--asu-gold)" }}>✦</span>
          AI-POWERED
        </div>

        <h1
          className="text-4xl sm:text-5xl font-bold leading-tight mb-4 max-w-2xl"
          style={{ color: "var(--text-primary)" }}
        >
          Ask about your school board meetings
        </h1>
        <p className="text-base max-w-lg mb-10" style={{ color: "var(--text-muted)" }}>
          Get clear answers about what happened at your local school board meetings. No jargon, no digging through documents.
        </p>

        {/* Search */}
        <div className="relative w-full max-w-lg mb-10">
          <svg
            className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4"
            style={{ color: "#555" }}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 105 11a6 6 0 0012 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search districts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-11 pr-4 py-3 rounded-xl text-sm outline-none transition-all"
            style={{
              background: "#1a1a1a",
              border: "1px solid #2a2a2a",
              color: "var(--text-primary)",
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "var(--asu-maroon)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "#2a2a2a";
            }}
          />
        </div>

        {/* District grid */}
        <div className="w-full max-w-4xl">
          {filtered.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              No districts found matching &ldquo;{search}&rdquo;
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filtered.map((district) => (
                <button
                  key={district.id}
                  onClick={() => router.push(`/district/${district.id}`)}
                  className="text-left p-4 rounded-xl border transition-all group"
                  style={{
                    background: "var(--bg-card)",
                    borderColor: "var(--border-subtle)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-card-hover)";
                    e.currentTarget.style.borderColor = "var(--asu-maroon)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--bg-card)";
                    e.currentTarget.style.borderColor = "var(--border-subtle)";
                  }}
                >
                  <div className="font-semibold text-sm mb-2" style={{ color: "var(--text-primary)" }}>
                    {district.name}
                  </div>
                  <div className="flex items-center gap-4 text-xs" style={{ color: "var(--text-muted)" }}>
                    <span className="flex items-center gap-1.5">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                      {district.meetings} meetings
                    </span>
                    <span className="flex items-center gap-1.5">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      Updated {UPDATED_DATES[district.id] ?? "Oct 2024"}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className="mt-auto py-8 text-center text-xs" style={{ color: "var(--text-muted)" }}>
        <p className="mb-1">
          Starting with {DISTRICTS.length} districts — more coming soon.
        </p>
        <p className="mb-3">
          Have a district you&apos;d love to see?{" "}
          <a
            href="mailto:thebeam@asu.edu"
            style={{ color: "var(--asu-gold)" }}
            className="hover:underline"
          >
            Let us know
          </a>
        </p>
        <p>Built by The Beam · ASU Cronkite School</p>
      </footer>
    </div>
  );
}
