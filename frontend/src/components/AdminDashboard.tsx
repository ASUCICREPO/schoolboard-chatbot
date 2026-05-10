"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { District, Transcript } from "@/types";
import { signIn, getSession, signOut } from "@/lib/auth";

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

type TabId = "districts" | "videos" | "transcripts" | "analytics";

const TABS: { id: TabId; label: string }[] = [
  { id: "districts", label: "Districts" },
  { id: "videos", label: "New Videos" },
  { id: "transcripts", label: "Transcripts" },
  { id: "analytics", label: "Analytics" },
];

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  active: { bg: "rgba(34,197,94,0.15)", text: "#4ade80" },
  inactive: { bg: "rgba(100,100,100,0.15)", text: "#666" },
  discovered: { bg: "rgba(168,85,247,0.15)", text: "#c084fc" },
  pending: { bg: "rgba(234,179,8,0.15)", text: "#facc15" },
  transcribing: { bg: "rgba(59,130,246,0.15)", text: "#60a5fa" },
  completed: { bg: "rgba(34,197,94,0.15)", text: "#4ade80" },
  failed: { bg: "rgba(239,68,68,0.15)", text: "#f87171" },
  unavailable: { bg: "rgba(100,100,100,0.15)", text: "#555" },
};

function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] ?? { bg: "#222", text: "#666" };
  return (
    <span
      className="text-xs px-2 py-0.5 rounded-full font-medium"
      style={{ background: colors.bg, color: colors.text }}
    >
      {status}
    </span>
  );
}

const API_URL_CONST = API_URL; // for use in sub-components

function TranscriptsTab({
  transcripts,
  getAuthHeaders,
  fetchData,
  setError,
}: {
  transcripts: Transcript[];
  getAuthHeaders: () => Record<string, string>;
  fetchData: () => void;
  setError: (e: string | null) => void;
}) {
  const [search, setSearch] = useState("");
  const [viewModal, setViewModal] = useState<{ transcript: Transcript; content: string } | null>(null);
  const [viewLoading, setViewLoading] = useState(false);

  const filtered = search
    ? transcripts.filter(
        (t) =>
          t.districtId.toLowerCase().includes(search.toLowerCase()) ||
          t.title.toLowerCase().includes(search.toLowerCase()),
      )
    : transcripts;

  // Group by district
  const grouped = (() => {
    const groups: Record<string, Transcript[]> = {};
    for (const t of filtered) {
      if (!groups[t.districtId]) groups[t.districtId] = [];
      groups[t.districtId].push(t);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  })();

  const handleView = async (t: Transcript) => {
    setViewLoading(true);
    try {
      const res = await fetch(
        `${API_URL_CONST}/admin/transcripts/${t.districtId}?videoId=${t.videoId}&view=content`,
        { headers: getAuthHeaders() },
      );
      const data = await res.json();
      setViewModal({ transcript: t, content: data.content ?? "No content available" });
    } catch {
      setError("Failed to load transcript content");
    } finally {
      setViewLoading(false);
    }
  };

  const handleDelete = async (t: Transcript) => {
    if (!confirm(`Delete transcript "${t.title}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(
        `${API_URL_CONST}/admin/transcripts/${t.districtId}?videoId=${t.videoId}`,
        { method: "DELETE", headers: getAuthHeaders() },
      );
      if (!res.ok) throw new Error("Failed to delete");
      fetchData();
    } catch {
      setError("Failed to delete transcript");
    }
  };

  const cardStyle = { background: "var(--bg-card)", borderColor: "var(--border-subtle)" };

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
          Transcripts ({transcripts.length})
        </h2>
        <button
          onClick={fetchData}
          className="px-3 py-1.5 rounded-lg border text-sm"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-muted)" }}
        >
          Refresh
        </button>
      </div>

      <input
        type="text"
        placeholder="Search by district or title…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full mb-4 px-3 py-2 rounded-lg text-sm outline-none"
        style={{ background: "var(--bg-card)", border: "1px solid var(--border-subtle)", color: "var(--text-primary)" }}
      />

      {grouped.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          {transcripts.length === 0 ? "No transcripts yet." : "No transcripts match your search."}
        </p>
      ) : (
        <div className="space-y-6">
          {grouped.map(([districtId, items]) => (
            <div key={districtId}>
              <h3 className="text-sm font-semibold mb-2 px-1" style={{ color: "var(--asu-gold)" }}>
                {districtId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                <span className="ml-2 font-normal" style={{ color: "var(--text-muted)" }}>({items.length})</span>
              </h3>
              <div className="space-y-2">
                {items.map((t) => (
                  <div key={`${t.districtId}-${t.videoId}`} className="rounded-xl border px-4 py-3" style={cardStyle}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate" style={{ color: "var(--text-primary)" }}>
                          {t.title}
                        </p>
                        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                          {t.publishedAt && `${new Date(t.publishedAt).toLocaleDateString()} · `}
                          {t.transcriptSource ?? ""}
                          {t.transcriptLength && ` · ${Number(t.transcriptLength).toLocaleString()} chars`}
                        </p>
                        {t.errorMessage && (
                          <p className="text-xs mt-0.5" style={{ color: "#f87171" }}>{t.errorMessage}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <StatusBadge status={t.status} />
                        {t.status === "completed" && (
                          <button
                            onClick={() => handleView(t)}
                            disabled={viewLoading}
                            className="text-xs px-2 py-1 rounded border"
                            style={{ borderColor: "var(--border-subtle)", color: "var(--asu-gold)" }}
                          >
                            View
                          </button>
                        )}
                        <button
                          onClick={() => handleDelete(t)}
                          className="text-xs px-2 py-1 rounded border"
                          style={{ borderColor: "rgba(239,68,68,0.3)", color: "#f87171" }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* View transcript modal */}
      {viewModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
        >
          <div
            className="w-full max-w-3xl max-h-[80vh] rounded-xl border p-6 flex flex-col"
            style={{ background: "var(--bg-card)", borderColor: "var(--border-subtle)" }}
          >
            <div className="flex justify-between items-start mb-3">
              <div>
                <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                  {viewModal.transcript.title}
                </h3>
                <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                  {viewModal.transcript.districtId}
                  {viewModal.transcript.transcriptLength &&
                    ` · ${Number(viewModal.transcript.transcriptLength).toLocaleString()} chars`}
                </p>
              </div>
              <button
                onClick={() => setViewModal(null)}
                className="text-xs px-3 py-1.5 rounded border"
                style={{ borderColor: "var(--border-subtle)", color: "var(--text-muted)" }}
              >
                Close
              </button>
            </div>
            <div
              className="flex-1 overflow-y-auto rounded-lg p-4 text-sm whitespace-pre-wrap"
              style={{ background: "var(--bg-dark)", color: "var(--text-primary)", lineHeight: "1.6" }}
            >
              {viewModal.content}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface AnalyticsData {
  totalQueries: number;
  answeredQueries: number;
  unansweredQueries: number;
  answerRate: number;
  uniqueSessions: number;
  avgQueryLength: number;
  avgAnswerLength: number;
  topDistricts: { districtId: string; count: number }[];
  dailyTrend: { date: string; count: number }[];
  topConcerns: { topic: string; count: number; examples: string[] }[];
}

function AnalyticsTab({ getAuthHeaders }: { getAuthHeaders: () => Record<string, string> }) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [dayRange, setDayRange] = useState(30);

  useEffect(() => {
    fetch(`${API_URL}/admin/analytics`, { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading analytics…</p>;
  if (!data) return <p className="text-sm" style={{ color: "#f87171" }}>Failed to load analytics.</p>;

  const cardStyle = { background: "var(--bg-card)", borderColor: "var(--border-subtle)" };

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Total Queries", value: data.totalQueries },
          { label: "Answer Rate", value: `${data.answerRate}%` },
          { label: "Unique Sessions", value: data.uniqueSessions },
          { label: "Avg Answer Length", value: `${data.avgAnswerLength} chars` },
        ].map((card) => (
          <div key={card.label} className="rounded-xl border p-4 text-center" style={cardStyle}>
            <p className="text-2xl font-bold" style={{ color: "var(--asu-gold)" }}>{card.value}</p>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{card.label}</p>
          </div>
        ))}
      </div>

      {/* Daily trend */}
      {(() => {
        // Build full date range with zeros for missing days
        const now = new Date();
        const days: { date: string; count: number }[] = [];
        for (let i = dayRange - 1; i >= 0; i--) {
          const d = new Date(now);
          d.setDate(d.getDate() - i);
          days.push({ date: d.toISOString().split('T')[0], count: 0 });
        }
        // Fill in actual counts
        const countMap = new Map(data.dailyTrend.map((d) => [d.date, d.count]));
        for (const day of days) {
          day.count = countMap.get(day.date) ?? 0;
        }
        const maxCount = Math.max(...days.map((d) => d.count), 1);

        return (
        <div className="rounded-xl border p-4" style={cardStyle}>
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              Queries Per Day
            </h3>
            <div className="flex gap-1">
              {[30, 60, 90].map((d) => (
                <button
                  key={d}
                  onClick={() => setDayRange(d)}
                  className="px-2 py-0.5 rounded text-xs"
                  style={{
                    background: dayRange === d ? "var(--asu-maroon)" : "transparent",
                    color: dayRange === d ? "white" : "var(--text-muted)",
                    border: dayRange === d ? "none" : "1px solid var(--border-subtle)",
                  }}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-end gap-px h-32">
            {days.map((d) => (
              <div key={d.date} className="flex-1 flex flex-col items-center justify-end h-full group relative">
                <div
                  className="w-full rounded-sm"
                  style={{
                    height: d.count > 0 ? `${Math.max((d.count / maxCount) * 100, 6)}%` : "2px",
                    background: d.count > 0 ? "var(--asu-maroon)" : "var(--border-subtle)",
                    opacity: d.count > 0 ? 1 : 0.3,
                  }}
                />
                {/* Tooltip on hover */}
                <div
                  className="absolute bottom-full mb-1 px-1.5 py-0.5 rounded text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity"
                  style={{ background: "#333", color: "#fff" }}
                >
                  {d.date}: {d.count}
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {days[0]?.date}
            </span>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {days[days.length - 1]?.date}
            </span>
          </div>
        </div>
        );
      })()}

      {/* Top districts */}
      {data.topDistricts.length > 0 && (
        <div className="rounded-xl border p-4" style={cardStyle}>
          <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--text-primary)" }}>
            Most Queried Districts
          </h3>
          <div className="space-y-2">
            {data.topDistricts.map((d) => {
              const maxCount = data.topDistricts[0]?.count ?? 1;
              return (
                <div key={d.districtId} className="flex items-center gap-3">
                  <span className="text-xs w-40 truncate" style={{ color: "var(--text-muted)" }}>
                    {d.districtId === "all" ? "All Districts" : d.districtId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                  </span>
                  <div className="flex-1 h-4 rounded-full overflow-hidden" style={{ background: "var(--bg-dark)" }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${(d.count / maxCount) * 100}%`,
                        background: "var(--asu-maroon)",
                      }}
                    />
                  </div>
                  <span className="text-xs font-medium w-8 text-right" style={{ color: "var(--text-primary)" }}>
                    {d.count}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Top concerns */}
      {data.topConcerns.length > 0 && (
        <div className="rounded-xl border p-4" style={cardStyle}>
          <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--text-primary)" }}>
            Top Concerns
          </h3>
          <div className="space-y-3">
            {data.topConcerns.map((c) => {
              const maxCount = data.topConcerns[0]?.count ?? 1;
              return (
                <div key={c.topic}>
                  <div className="flex items-center gap-3 mb-1">
                    <span className="text-sm font-medium w-48 truncate" style={{ color: "var(--text-primary)" }}>
                      {c.topic}
                    </span>
                    <div className="flex-1 h-3 rounded-full overflow-hidden" style={{ background: "var(--bg-dark)" }}>
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${(c.count / maxCount) * 100}%`,
                          background: "var(--asu-gold)",
                        }}
                      />
                    </div>
                    <span className="text-xs font-medium w-8 text-right" style={{ color: "var(--text-primary)" }}>
                      {c.count}
                    </span>
                  </div>
                  {c.examples.length > 0 && (
                    <div className="ml-2 pl-4 border-l" style={{ borderColor: "var(--border-subtle)" }}>
                      {c.examples.map((ex, i) => (
                        <p key={i} className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
                          &ldquo;{ex}&rdquo;
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminDashboard() {
  const [tab, setTab] = useState<TabId>("videos");
  const [districts, setDistricts] = useState<District[]>([]);
  const [videos, setVideos] = useState<Transcript[]>([]);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadTarget, setUploadTarget] = useState<{ districtId: string; videoId: string; title: string } | null>(null);

  // ── District management state ──────────────────────────────────────────────
  const [districtSearch, setDistrictSearch] = useState("");
  const [showAddDistrict, setShowAddDistrict] = useState(false);
  const [districtForm, setDistrictForm] = useState({ id: "", name: "", youtubeUrl: "" });
  const [editingDistrict, setEditingDistrict] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", youtubeUrl: "" });
  const [districtSubmitting, setDistrictSubmitting] = useState(false);

  // ── Auth state ─────────────────────────────────────────────────────────────
  const [token, setToken] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginSubmitting, setLoginSubmitting] = useState(false);

  // Check for existing session on mount
  useEffect(() => {
    getSession().then((t) => {
      setToken(t);
      setAuthLoading(false);
    });
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginSubmitting(true);
    setLoginError(null);

    const result = await signIn(loginForm.username, loginForm.password);

    if (result.success && result.token) {
      setToken(result.token);
    } else {
      setLoginError(result.error ?? "Login failed");
    }
    setLoginSubmitting(false);
  };

  const handleSignOut = () => {
    signOut();
    setToken(null);
  };

  const getAuthHeaders = (): Record<string, string> => (token ? { Authorization: token } : {});

  // ── District CRUD handlers ─────────────────────────────────────────────────

  const handleAddDistrict = async (e: React.FormEvent) => {
    e.preventDefault();
    setDistrictSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/admin/districts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          id: districtForm.id || undefined,
          name: districtForm.name,
          youtubeUrl: districtForm.youtubeUrl,
        }),
      });
      if (!res.ok) throw new Error("Failed to create district");
      setDistrictForm({ id: "", name: "", youtubeUrl: "" });
      setShowAddDistrict(false);
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create district");
    } finally {
      setDistrictSubmitting(false);
    }
  };

  const handleEditDistrict = async (districtId: string) => {
    setDistrictSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/admin/districts/${districtId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          name: editForm.name,
          youtubeUrl: editForm.youtubeUrl,
        }),
      });
      if (!res.ok) throw new Error("Failed to update district");
      setEditingDistrict(null);
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update district");
    } finally {
      setDistrictSubmitting(false);
    }
  };

  const handleDeleteDistrict = async (districtId: string, name: string) => {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${API_URL}/admin/districts/${districtId}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error("Failed to delete district");
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete district");
    }
  };

  const startEditing = (d: District) => {
    setEditingDistrict(d.districtId);
    setEditForm({ name: d.name, youtubeUrl: d.youtubeUrl ?? "" });
  };

  const filteredDistricts = districtSearch
    ? districts.filter(
        (d) =>
          d.name.toLowerCase().includes(districtSearch.toLowerCase()) ||
          d.districtId.toLowerCase().includes(districtSearch.toLowerCase()),
      )
    : districts;

  const sortedDistricts = [...filteredDistricts].sort((a, b) => a.name.localeCompare(b.name));

  // ── YouTube scan ───────────────────────────────────────────────────────────
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);

  const handleScanChannels = async () => {
    setScanning(true);
    setScanResult(null);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Scan failed");
      setScanResult(data.message);
      // Refresh the videos tab
      if (tab === "videos") fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  };

  // ── Data fetching ──────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    const headers: Record<string, string> = token ? { Authorization: token } : {};
    setLoading(true);
    setError(null);
    try {
      if (tab === "districts") {
        const res = await fetch(`${API_URL}/admin/districts`, { headers });
        const data = await res.json();
        setDistricts(data.districts ?? []);
      } else if (tab === "videos") {
        const res = await fetch(`${API_URL}/admin/videos`, { headers });
        const data = await res.json();
        setVideos(data.videos ?? []);
      } else {
        const res = await fetch(`${API_URL}/admin/transcripts`, { headers });
        const data = await res.json();
        setTranscripts(
          (data.transcripts ?? [])
            .filter((t: Transcript) => t.status === "completed" || t.status === "transcribing" || t.status === "pending")
            .sort((a: Transcript, b: Transcript) =>
              (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt)
            ),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [tab, token]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Upload handlers ────────────────────────────────────────────────────────

  const handleUploadClick = (districtId: string, videoId: string, title: string) => {
    setUploadTarget({ districtId, videoId, title });
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !uploadTarget) return;

    setUploading(uploadTarget.videoId);
    try {
      // Get presigned upload URL
      const res = await fetch(`${API_URL}/admin/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          districtId: uploadTarget.districtId,
          title: uploadTarget.title,
          fileName: file.name,
          contentType: file.type || "application/octet-stream",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to get upload URL");

      // Upload file directly to S3
      const uploadRes = await fetch(data.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!uploadRes.ok) throw new Error("Failed to upload file to S3");

      // Refresh the list
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(null);
      setUploadTarget(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handlePasteTranscript = async (districtId: string, title: string) => {
    setPasteModal({ districtId, title, text: "" });
  };

  const [pasteModal, setPasteModal] = useState<{ districtId: string; title: string; text: string } | null>(null);
  const [pasteSubmitting, setPasteSubmitting] = useState(false);

  const handleSubmitPaste = async () => {
    if (!pasteModal || !pasteModal.text.trim()) return;
    setPasteSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/admin/transcripts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          districtId: pasteModal.districtId,
          title: pasteModal.title,
          text: pasteModal.text,
        }),
      });
      // 502 can happen if KB sync takes too long — transcript still saves
      if (!res.ok && res.status !== 502) throw new Error("Failed to upload transcript");
      setPasteModal(null);
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setPasteSubmitting(false);
    }
  };

  // ── Search state ───────────────────────────────────────────────────────────
  const [videoSearch, setVideoSearch] = useState("");

  // Group videos by district and filter by search
  const groupedVideos = (() => {
    const filtered = videoSearch
      ? videos.filter(
          (v) =>
            v.districtId.toLowerCase().includes(videoSearch.toLowerCase()) ||
            v.title.toLowerCase().includes(videoSearch.toLowerCase()),
        )
      : videos;

    const groups: Record<string, Transcript[]> = {};
    for (const v of filtered) {
      if (!groups[v.districtId]) groups[v.districtId] = [];
      groups[v.districtId].push(v);
    }
    // Sort districts alphabetically
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  })();

  // ── Styles ─────────────────────────────────────────────────────────────────

  const cardStyle = {
    background: "var(--bg-card)",
    borderColor: "var(--border-subtle)",
  };

  const btnPrimary = {
    background: "var(--asu-maroon)",
    color: "white",
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-dark)" }}>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,video/*,.txt,.vtt,.srt"
        className="hidden"
        onChange={handleFileSelected}
      />

      {/* ── Login Screen ──────────────────────────────────────────────── */}
      {authLoading ? (
        <div className="flex items-center justify-center min-h-screen">
          <p style={{ color: "var(--text-muted)" }}>Loading…</p>
        </div>
      ) : !token ? (
        <div className="flex items-center justify-center min-h-screen px-4">
          <div
            className="w-full max-w-sm rounded-xl border p-6"
            style={{ background: "var(--bg-card)", borderColor: "var(--border-subtle)" }}
          >
            <div className="flex items-center gap-3 mb-6">
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
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>Sign in to continue</p>
              </div>
            </div>

            {loginError && (
              <div
                className="mb-4 px-3 py-2 rounded-lg text-xs"
                style={{ background: "rgba(239,68,68,0.1)", color: "#f87171" }}
              >
                {loginError}
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: "var(--text-muted)" }}>
                  Username
                </label>
                <input
                  required
                  value={loginForm.username}
                  onChange={(e) => setLoginForm((f) => ({ ...f, username: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                  style={{
                    background: "var(--bg-dark)",
                    border: "1px solid var(--border-subtle)",
                    color: "var(--text-primary)",
                  }}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: "var(--text-muted)" }}>
                  Password
                </label>
                <input
                  required
                  type="password"
                  value={loginForm.password}
                  onChange={(e) => setLoginForm((f) => ({ ...f, password: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                  style={{
                    background: "var(--bg-dark)",
                    border: "1px solid var(--border-subtle)",
                    color: "var(--text-primary)",
                  }}
                />
              </div>
              <button
                type="submit"
                disabled={loginSubmitting}
                className="w-full py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                style={{ background: "var(--asu-maroon)" }}
              >
                {loginSubmitting ? "Signing in…" : "Sign In"}
              </button>
            </form>
          </div>
        </div>
      ) : (
      /* ── Authenticated Dashboard ────────────────────────────────────── */
      <>

      {/* Header */}
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
        <div className="flex items-center gap-3">
          <a
            href="/"
            className="text-xs px-3 py-1.5 rounded-lg border transition-colors"
            style={{ borderColor: "#333", color: "#888" }}
          >
            ← Back to App
          </a>
          <button
            onClick={handleSignOut}
            className="text-xs px-3 py-1.5 rounded-lg border transition-colors"
            style={{ borderColor: "#333", color: "#888" }}
          >
            Sign Out
          </button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* Tabs */}
        <div className="flex gap-1 border-b mb-6" style={{ borderColor: "var(--border-subtle)" }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="px-4 py-2 text-sm font-medium rounded-t-lg transition-colors -mb-px"
              style={
                tab === t.id
                  ? {
                      background: "var(--bg-card)",
                      border: "1px solid var(--border-subtle)",
                      borderBottom: "1px solid var(--bg-card)",
                      color: "var(--asu-gold)",
                    }
                  : { color: "var(--text-muted)", border: "1px solid transparent" }
              }
            >
              {t.label}
              {t.id === "videos" && videos.length > 0 && (
                <span
                  className="ml-1.5 text-xs px-1.5 py-0.5 rounded-full"
                  style={{ background: "rgba(168,85,247,0.2)", color: "#c084fc" }}
                >
                  {videos.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {error && (
          <div
            className="mb-4 px-4 py-3 rounded-lg text-sm"
            style={{ background: "rgba(140,29,64,0.15)", border: "1px solid rgba(140,29,64,0.4)", color: "#f87171" }}
          >
            {error}
            <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
          </div>
        )}

        {loading && <p className="text-sm mb-4" style={{ color: "var(--text-muted)" }}>Loading…</p>}

        {/* ── Districts Tab ─────────────────────────────────────────────── */}
        {tab === "districts" && !loading && (
          <div>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
                Districts ({districts.length})
              </h2>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowAddDistrict((v) => !v)}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium text-white"
                  style={{ background: "var(--asu-maroon)" }}
                >
                  {showAddDistrict ? "Cancel" : "+ Add District"}
                </button>
                <button
                  onClick={fetchData}
                  className="px-3 py-1.5 rounded-lg border text-sm"
                  style={{ borderColor: "var(--border-subtle)", color: "var(--text-muted)" }}
                >
                  Refresh
                </button>
              </div>
            </div>

            {/* Add district form */}
            {showAddDistrict && (
              <form
                onSubmit={handleAddDistrict}
                className="mb-4 rounded-xl border p-4 space-y-3"
                style={{ background: "var(--bg-card)", borderColor: "var(--border-subtle)" }}
              >
                <h3 className="font-medium text-sm" style={{ color: "var(--text-primary)" }}>New District</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: "var(--text-muted)" }}>
                      ID (optional, auto-generated from name)
                    </label>
                    <input
                      value={districtForm.id}
                      onChange={(e) => setDistrictForm((f) => ({ ...f, id: e.target.value }))}
                      placeholder="e.g. tempe-elementary"
                      className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                      style={{ background: "var(--bg-dark)", border: "1px solid var(--border-subtle)", color: "var(--text-primary)" }}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: "var(--text-muted)" }}>
                      Name *
                    </label>
                    <input
                      required
                      value={districtForm.name}
                      onChange={(e) => setDistrictForm((f) => ({ ...f, name: e.target.value }))}
                      placeholder="e.g. Tempe Elementary"
                      className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                      style={{ background: "var(--bg-dark)", border: "1px solid var(--border-subtle)", color: "var(--text-primary)" }}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: "var(--text-muted)" }}>
                      YouTube URL
                    </label>
                    <input
                      value={districtForm.youtubeUrl}
                      onChange={(e) => setDistrictForm((f) => ({ ...f, youtubeUrl: e.target.value }))}
                      placeholder="e.g. https://youtube.com/@handle/streams"
                      className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                      style={{ background: "var(--bg-dark)", border: "1px solid var(--border-subtle)", color: "var(--text-primary)" }}
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={districtSubmitting}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                  style={{ background: "var(--asu-maroon)" }}
                >
                  {districtSubmitting ? "Creating…" : "Create District"}
                </button>
              </form>
            )}

            {/* Search */}
            <input
              type="text"
              placeholder="Search districts…"
              value={districtSearch}
              onChange={(e) => setDistrictSearch(e.target.value)}
              className="w-full mb-4 px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: "var(--bg-card)", border: "1px solid var(--border-subtle)", color: "var(--text-primary)" }}
            />

            {sortedDistricts.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                {districts.length === 0 ? "No districts. Click \"+ Add District\" or run a YouTube scan to populate." : "No districts match your search."}
              </p>
            ) : (
              <div className="space-y-2">
                {sortedDistricts.map((d) => (
                  <div
                    key={d.districtId}
                    className="rounded-xl border px-4 py-3"
                    style={cardStyle}
                  >
                    {editingDistrict === d.districtId ? (
                      /* Edit mode */
                      <div className="space-y-2">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <input
                            value={editForm.name}
                            onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                            placeholder="District name"
                            className="px-3 py-1.5 rounded-lg text-sm outline-none"
                            style={{ background: "var(--bg-dark)", border: "1px solid var(--border-subtle)", color: "var(--text-primary)" }}
                          />
                          <input
                            value={editForm.youtubeUrl}
                            onChange={(e) => setEditForm((f) => ({ ...f, youtubeUrl: e.target.value }))}
                            placeholder="YouTube URL"
                            className="px-3 py-1.5 rounded-lg text-sm outline-none"
                            style={{ background: "var(--bg-dark)", border: "1px solid var(--border-subtle)", color: "var(--text-primary)" }}
                          />
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleEditDistrict(d.districtId)}
                            disabled={districtSubmitting}
                            className="px-3 py-1 rounded-lg text-xs font-medium text-white disabled:opacity-50"
                            style={{ background: "var(--asu-maroon)" }}
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingDistrict(null)}
                            className="px-3 py-1 rounded-lg text-xs border"
                            style={{ borderColor: "var(--border-subtle)", color: "var(--text-muted)" }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* View mode */
                      <div className="flex items-center justify-between">
                        <div className="min-w-0">
                          <p className="font-medium text-sm" style={{ color: "var(--text-primary)" }}>{d.name}</p>
                          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                            {d.districtId}
                            {d.youtubeUrl && (
                              <>
                                {" · "}
                                <a
                                  href={d.youtubeUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="hover:underline"
                                  style={{ color: "var(--asu-gold)" }}
                                >
                                  YouTube ↗
                                </a>
                              </>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <button
                            onClick={() => startEditing(d)}
                            className="text-xs px-2 py-1 rounded border"
                            style={{ borderColor: "var(--border-subtle)", color: "var(--text-muted)" }}
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteDistrict(d.districtId, d.name)}
                            className="text-xs px-2 py-1 rounded border"
                            style={{ borderColor: "rgba(239,68,68,0.3)", color: "#f87171" }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── New Videos Tab ────────────────────────────────────────────── */}
        {tab === "videos" && !loading && (
          <div>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
                New Videos ({videos.length})
              </h2>
              <div className="flex gap-2">
                <button
                  onClick={handleScanChannels}
                  disabled={scanning}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                  style={{ background: "var(--asu-maroon)" }}
                >
                  {scanning ? "Scanning…" : "Scan YouTube Channels"}
                </button>
                <button
                  onClick={fetchData}
                  className="px-3 py-1.5 rounded-lg border text-sm"
                  style={{ borderColor: "var(--border-subtle)", color: "var(--text-muted)" }}
                >
                  Refresh
                </button>
              </div>
            </div>

            {scanResult && (
              <div
                className="mb-4 px-4 py-3 rounded-lg text-sm"
                style={{ background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)", color: "#4ade80" }}
              >
                {scanResult}
              </div>
            )}

            {/* Search bar */}
            <input
              type="text"
              placeholder="Search by district name…"
              value={videoSearch}
              onChange={(e) => setVideoSearch(e.target.value)}
              className="w-full mb-4 px-3 py-2 rounded-lg text-sm outline-none"
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border-subtle)",
                color: "var(--text-primary)",
              }}
            />

            {groupedVideos.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                  {videos.length === 0
                    ? 'No new videos discovered. Click "Scan YouTube Channels" to check now.'
                    : "No districts match your search."}
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {groupedVideos.map(([districtId, districtVideos]) => (
                  <div key={districtId}>
                    <h3
                      className="text-sm font-semibold mb-2 px-1"
                      style={{ color: "var(--asu-gold)" }}
                    >
                      {districtId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                      <span className="ml-2 font-normal" style={{ color: "var(--text-muted)" }}>
                        ({districtVideos.length})
                      </span>
                    </h3>
                    <div className="space-y-2">
                      {districtVideos.map((v) => (
                        <div
                          key={`${v.districtId}-${v.videoId}`}
                          className="rounded-xl border p-4"
                          style={cardStyle}
                        >
                          <div className="flex gap-4">
                            {v.thumbnail && (
                              <a
                                href={`https://www.youtube.com/watch?v=${v.videoId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex-shrink-0"
                              >
                                <img
                                  src={v.thumbnail}
                                  alt={v.title}
                                  className="w-40 h-24 object-cover rounded-lg"
                                />
                              </a>
                            )}
                            <div className="flex-1 min-w-0">
                              <a
                                href={`https://www.youtube.com/watch?v=${v.videoId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-medium text-sm hover:underline block truncate"
                                style={{ color: "var(--text-primary)" }}
                              >
                                {v.title}
                              </a>
                              <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                                {v.publishedAt ? new Date(v.publishedAt).toLocaleDateString() : "Unknown date"}
                              </p>
                              <div className="flex gap-2 mt-3">
                                <button
                                  onClick={() => handleUploadClick(v.districtId, v.videoId, v.title)}
                                  disabled={uploading === v.videoId}
                                  className="px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                                  style={btnPrimary}
                                >
                                  {uploading === v.videoId ? "Uploading…" : "Upload Audio/Video"}
                                </button>
                                <button
                                  onClick={() => handlePasteTranscript(v.districtId, v.title)}
                                  className="px-3 py-1.5 rounded-lg text-xs font-medium border"
                                  style={{ borderColor: "var(--border-subtle)", color: "var(--text-muted)" }}
                                >
                                  Paste Transcript
                                </button>
                                <a
                                  href={`https://www.youtube.com/watch?v=${v.videoId}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="px-3 py-1.5 rounded-lg text-xs font-medium border"
                                  style={{ borderColor: "var(--border-subtle)", color: "var(--asu-gold)" }}
                                >
                                  YouTube ↗
                                </a>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Paste Transcript Modal ────────────────────────────────────── */}
        {pasteModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center px-4"
            style={{ background: "rgba(0,0,0,0.7)" }}
          >
            <div
              className="w-full max-w-2xl rounded-xl border p-6"
              style={{ background: "var(--bg-card)", borderColor: "var(--border-subtle)" }}
            >
              <h3 className="text-sm font-semibold mb-1" style={{ color: "var(--text-primary)" }}>
                Paste Transcript
              </h3>
              <p className="text-xs mb-3" style={{ color: "var(--text-muted)" }}>
                {pasteModal.title} — {pasteModal.districtId}
              </p>
              <textarea
                value={pasteModal.text}
                onChange={(e) => setPasteModal((m) => m ? { ...m, text: e.target.value } : null)}
                placeholder="Paste the full transcript text here…"
                rows={16}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-y"
                style={{
                  background: "var(--bg-dark)",
                  border: "1px solid var(--border-subtle)",
                  color: "var(--text-primary)",
                  minHeight: "200px",
                }}
              />
              <p className="text-xs mt-1 mb-3" style={{ color: "var(--text-muted)" }}>
                {pasteModal.text.length.toLocaleString()} characters
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setPasteModal(null)}
                  className="px-4 py-2 rounded-lg text-sm border"
                  style={{ borderColor: "var(--border-subtle)", color: "var(--text-muted)" }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmitPaste}
                  disabled={pasteSubmitting || !pasteModal.text.trim()}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                  style={{ background: "var(--asu-maroon)" }}
                >
                  {pasteSubmitting ? "Uploading…" : "Upload Transcript"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Transcripts Tab ───────────────────────────────────────────── */}
        {tab === "transcripts" && !loading && (
          <TranscriptsTab
            transcripts={transcripts}
            getAuthHeaders={getAuthHeaders}
            fetchData={fetchData}
            setError={setError}
          />
        )}

        {/* ── Analytics Tab ─────────────────────────────────────────────── */}
        {tab === "analytics" && (
          <AnalyticsTab getAuthHeaders={getAuthHeaders} />
        )}
      </div>
      </>
      )}
    </div>
  );
}
