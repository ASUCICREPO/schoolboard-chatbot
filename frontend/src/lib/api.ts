import type { ChatRequest, ChatResponse, District } from "@/types";

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

export async function fetchDistricts(): Promise<District[]> {
  const res = await fetch(`${API_URL}/districts`, {
    next: { revalidate: 300 },
  });
  if (!res.ok) throw new Error("Failed to fetch districts");
  const data = await res.json();
  return data.districts ?? [];
}

export async function sendChatMessage(
  req: ChatRequest,
): Promise<ChatResponse> {
  const res = await fetch(`${API_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? "Chat request failed");
  }
  return data as ChatResponse;
}
