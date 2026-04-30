"use client";

import { useState, useEffect, useCallback } from "react";
import type { District, Transcript } from "@/types";

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

interface Tab {
  id: "districts" | "transcripts";
  label: string;
}

const TABS: Tab[] = [
  { id: "districts", label: "Districts" },
  { id: "transcripts", label: "Transcripts" },
];

const STATUS_STYLES: Record<string, { bg: string; color: string }> = {
  active: { bg: "rgba(34,197,94,0.15)", color: "#4ade80" },
  inactive: { bg: "rgba(100,100,100,0.15)", color: "#666" },
  completed: { bg: "rgba(34,197,94,0.15)", color: "#4ade80" },
  pending: { bg: "rgba(234,179,8,0.15)", color: "#facc15" },
  processing: { bg: "rgba(59,130,246,0.15)", color: "#60a5fa" },
  failed: { bg: "rgba(239,68,68,0.15)", color: "#f87171" },
  unavailable: { bg: "rgba(100,100,100,0.15)", color: "#555" },
};

export default function AdminDashboard() {
  const [activeTab, setActiveTab] = useState<Tab["id"]>("districts");
  const [districts, setDistricts] = useState<District[]>([]);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", youtubeChannelId: "", description: "" });
  const [submitting, setSubmitting] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (activeTab === "districts") {
        const res = await fetch(`${API_URL}/admin/districts`);
        const data = await res.json();
        setDistricts(data.districts ?? []);
      } else {
        const res = await fetch(`${API_URL}/admin/transcripts`);
        const data = await res.json();
        setTranscripts(data.transcripts ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleCreateDistrict = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/admin/districts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, state: "AZ" }),
      });
      if (!res.ok) throw new Error("Failed to create district");
      setForm({ name: "", youtubeChannelId: "", description: "" });
      setShowForm(false);
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create district");
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleStatus = async (district: District) => {
    try {
      const newStatus = district.status === "active" ? "inactive" : "active";
      await fetch(`${API_URL}/admin/districts/${district.districtId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      fetchData();
    } catch {
      setError("Failed to update district");
    }
  };

  const inputStyle = {
    background: "var(--bg-card)",
    border: "1px solid var(--border-subtle)",
    color: "var(--text-primary)",
    borderRadius: "8px",
    padding: "8px 12px",
    fontSize: "14px",
    width: "100%",
    outline: "none",
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-dark)" }}>
      <header
        className="border-b px-6 py-4 flex items-center justify-between"
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
            <h1 className="text-base font-bold" style={{ color: "var(--text-primary)" }}>
              The Beam Admin
            </h1>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              School Board Meeting Management
            </p>
          </div>
        </div>
        <a
          href="/"
          className="text-xs px-3 py-1.5 rounded-lg border transition-colors"
          style={{ borderColor: "#333", color: "#888" }}
        >
          ← Back to App
        </a>
      </header>

      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex gap-1 border-b mb-6" style={{ borderColor: "var(--border-subtle)" }}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="px-4 py-2 text-sm font-medium rounded-t-lg transition-colors -mb-px"
              style={
                activeTab === tab.id
                  ? {
                      background: "var(--bg-card)",
                      border: "1px solid var(--border-subtle)",
                      borderBottom: "1px solid var(--bg-card)",
                      color: "var(--asu-gold)",
                    }
                  : { color: "var(--text-muted)", border: "1px solid transparent" }
              }
            >
              {tab.label}
            </button>
          ))}
        </div>

        {error && (
          <div
            className="mb-4 px-4 py-3 rounded-lg text-sm"
            style={{ background: "rgba(140,29,64,0.15)", border: "1px solid rgba(140,29,64,0.4)", color: "#f87171" }}
          >
            {error}
          </div>
        )}

        {activeTab === "districts" && (
          <div>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
                Districts ({districts.length})
              </h2>
              <button
                onClick={() => setShowForm((v) => !v)}
                className="px-3 py-1.5 rounded-lg text-sm font-medium text-white transition-colors"
                style={{ background: "var(--asu-maroon)" }}
              >
                {showForm ? "Cancel" : "+ Add District"}
              </button>
            </div>

            {showForm && (
              <form
                onSubmit={handleCreateDistrict}
                className="mb-6 rounded-xl border p-4 space-y-3"
                style={{ background: "var(--bg-card)", borderColor: "var(--border-subtle)" }}
              >
                <h3 className="font-medium text-sm" style={{ color: "var(--text-primary)" }}>New District</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: "var(--text-muted)" }}>
                      District Name *
                    </label>
                    <input
                      required
                      value={form.name}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                      placeholder="e.g. Tempe Elementary School District"
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: "var(--text-muted)" }}>
                      YouTube Channel ID *
                    </label>
                    <input
                      required
                      value={form.youtubeChannelId}
                      onChange={(e) => setForm((f) => ({ ...f, youtubeChannelId: e.target.value }))}
                      placeholder="UC..."
                      style={inputStyle}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: "var(--text-muted)" }}>
                    Description
                  </label>
                  <input
                    value={form.description}
                    onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                    placeholder="Optional description"
                    style={inputStyle}
                  />
                </div>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded-lg text-white text-sm disabled:opacity-50 transition-colors"
                  style={{ background: "var(--asu-maroon)" }}
                >
                  {submitting ? "Creating…" : "Create District"}
                </button>
              </form>
            )}

            {loading ? (
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading…</p>
            ) : districts.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>No districts configured.</p>
            ) : (
              <div className="space-y-2">
                {districts.map((d) => (
                  <div
                    key={d.districtId}
                    className="rounded-xl border px-4 py-3 flex items-center justify-between"
                    style={{ background: "var(--bg-card)", borderColor: "var(--border-subtle)" }}
                  >
                    <div>
                      <p className="font-medium text-sm" style={{ color: "var(--text-primary)" }}>{d.name}</p>
                      <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                        Channel: {d.youtubeChannelId}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span
                        className="text-xs px-2 py-0.5 rounded-full font-medium"
                        style={STATUS_STYLES[d.status] ?? { bg: "#222", color: "#666" }}
                      >
                        {d.status}
                      </span>
                      <button
                        onClick={() => handleToggleStatus(d)}
                        className="text-xs underline transition-colors"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {d.status === "active" ? "Deactivate" : "Activate"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "transcripts" && (
          <div>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
                Transcripts ({transcripts.length})
              </h2>
              <button
                onClick={fetchData}
                className="px-3 py-1.5 rounded-lg border text-sm transition-colors"
                style={{ borderColor: "var(--border-subtle)", color: "var(--text-muted)" }}
              >
                Refresh
              </button>
            </div>

            {loading ? (
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading…</p>
            ) : transcripts.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>No transcripts found.</p>
            ) : (
              <div className="space-y-2">
                {transcripts
                  .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
                  .map((t) => (
                    <div
                      key={`${t.districtId}-${t.videoId}`}
                      className="rounded-xl border px-4 py-3"
                      style={{ background: "var(--bg-card)", borderColor: "var(--border-subtle)" }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate" style={{ color: "var(--text-primary)" }}>
                            {t.title}
                          </p>
                          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                            {t.districtId} · {new Date(t.publishedAt).toLocaleDateString()}
                          </p>
                          {t.errorMessage && (
                            <p className="text-xs mt-0.5" style={{ color: "#f87171" }}>
                              {t.errorMessage}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span
                            className="text-xs px-2 py-0.5 rounded-full font-medium"
                            style={STATUS_STYLES[t.status] ?? { background: "#222", color: "#666" }}
                          >
                            {t.status}
                          </span>
                          {t.status === "completed" && (
                            <a
                              href={`https://www.youtube.com/watch?v=${t.videoId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs hover:underline"
                              style={{ color: "var(--asu-gold)" }}
                            >
                              YouTube ↗
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
