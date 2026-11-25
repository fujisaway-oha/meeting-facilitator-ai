export interface BoardItem {
  id: string;
  category: "decisions" | "requests" | "waiting_materials" | "undecided";
  content: string;
  is_locked: boolean;
  carried_over: boolean;
}

export type BoardMap = Record<BoardItem["category"], BoardItem[]>;

export interface Utterance {
  id: string;
  seq_no: number;
  speaker: string;
  text: string;
  source: string;
  created_at: string;
}

export interface MeetingSummaryInfo {
  id: string;
  project_id: string;
  project_name?: string;
  client_name?: string;
  title: string;
  agenda: string;
  duration_minutes: number;
  status: string;
  summary_markdown: string;
  started_at: string;
}

export async function apiJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || data.error || `HTTP ${res.status}`);
  }
  return data as T;
}
