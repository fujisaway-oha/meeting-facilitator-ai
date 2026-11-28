import {
  apiJson,
  type BoardItem,
  type BoardMap,
  type MeetingSummaryInfo,
  type ProjectInfo,
  type Utterance,
} from "./api/client";
import { HybridVideoSvgAvatarRenderer } from "./avatar/AvatarRenderer";

const ECHO_TAIL_GUARD_MS = 300;
const RECENT_HUD_COUNT = 4;

const SAMPLES = [
  { speaker: "クライアント", text: "スマホ表示のとき、画面下部に予約ボタンを固定したいです。" },
  { speaker: "クライアント", text: "トップページのメイン写真は来週金曜までに弊社から支給します。" },
  { speaker: "クライアント", text: "お問い合わせフォームで電話番号を必須にするかは社内で確認後に連絡します。" },
  { speaker: "制作担当", text: "初回公開日は来月20日で進めましょう。こちらは合意・決定ですね。" },
];

function $<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing DOM element: #${id}`);
  return node as T;
}

const avatar = new HybridVideoSvgAvatarRenderer((label, state) => {
  const pill = document.getElementById("avatarStatePill");
  if (pill) pill.textContent = label;
  updateHintVisibility(state);
});

let ollamaConnected = false;
let soundEnabled = true;
let echoGateActive = false;
let avatarMounted = false;
let hasStartedDialogue = false;
let localVoiceActionInFlight = false;

let lobbyMeetings: MeetingSummaryInfo[] = [];
let lobbyStatusFilter: "all" | "active" | "completed" = "all";

let currentMeeting: MeetingSummaryInfo | null = null;
let currentProjectId = "";
let currentMeetingId = "";
let currentUtterances: Utterance[] = [];
let currentBoard: BoardMap = emptyBoard();
let editingBoardItemId: string | null = null;

let currentSocket: WebSocket | null = null;
let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: BlobPart[] = [];
let voiceTalkRecorder: MediaRecorder | null = null;
let sampleIdx = 0;

function emptyBoard(): BoardMap {
  return {
    decisions: [],
    requests: [],
    waiting_materials: [],
    undecided: [],
  };
}

function isCurrentMeetingCompleted(): boolean {
  return currentMeeting?.status === "completed";
}

function shouldUseMock(): boolean {
  const mode = $<HTMLSelectElement>("modeSelect").value;
  if (mode === "mock") return true;
  if (mode === "ollama") return false;
  return !ollamaConnected;
}

function updateHintVisibility(state?: string): void {
  const hint = document.getElementById("voiceTalkHint");
  if (!hint) return;
  if (isCurrentMeetingCompleted()) {
    hint.hidden = true;
    return;
  }
  if (!hasStartedDialogue) {
    hint.hidden = false;
    return;
  }
  hint.hidden = state === "idle";
}

function restackToasts(): void {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const items = Array.from(container.querySelectorAll<HTMLElement>(".toast-item"));
  items.forEach((el, idx) => {
    const reverseIndex = items.length - 1 - idx;
    el.style.setProperty("--toast-index", String(reverseIndex));
  });
}

function showToast(
  message: string,
  variant: "info" | "success" | "error" = "info",
  durationMs = 4200,
): void {
  const container = $<HTMLDivElement>("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast-item toast-${variant}`;
  toast.setAttribute("role", variant === "error" ? "alert" : "status");

  const supportsPopover = "popover" in HTMLElement.prototype;
  if (supportsPopover) {
    toast.setAttribute("popover", "manual");
  }

  const textSpan = document.createElement("span");
  textSpan.textContent = message;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "toast-close-btn";
  closeBtn.setAttribute("aria-label", "通知を閉じる");
  closeBtn.textContent = "✕";

  let timerId = 0;
  const dismiss = () => {
    if (timerId) {
      window.clearTimeout(timerId);
      timerId = 0;
    }
    if (supportsPopover && toast.matches(":popover-open")) {
      try {
        (toast as HTMLElement & { hidePopover: () => void }).hidePopover();
      } catch {
        // ignore if already hidden
      }
    }
    toast.remove();
    restackToasts();
  };

  closeBtn.addEventListener("click", dismiss);
  toast.append(textSpan, closeBtn);
  container.appendChild(toast);
  restackToasts();

  if (supportsPopover) {
    try {
      (toast as HTMLElement & { showPopover: () => void }).showPopover();
    } catch {
      toast.classList.add(":popover-open");
    }
  }

  timerId = window.setTimeout(dismiss, durationMs);
}

function installDialogLightDismissFallback(): void {
  if ("closedBy" in HTMLDialogElement.prototype) return;
  document.querySelectorAll<HTMLDialogElement>('dialog[closedby="any"]').forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const isDialogContent =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (isDialogContent) return;
      dialog.close();
    });
  });
}

function setEchoGate(active: boolean): void {
  echoGateActive = active;
  const recordBtn = $<HTMLButtonElement>("recordBtn");
  const voiceTalkBtn = $<HTMLButtonElement>("voiceTalkBtn");
  const gateStatus = $<HTMLParagraphElement>("echoGateStatus");
  const completed = isCurrentMeetingCompleted();

  if (active) {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
    if (voiceTalkRecorder && voiceTalkRecorder.state === "recording") {
      voiceTalkRecorder.stop();
    }
    recordBtn.disabled = true;
    voiceTalkBtn.disabled = true;
    gateStatus.textContent = "🔇 AI発話中（自己音声エコー抑止ゲート作動中）";
  } else {
    recordBtn.disabled = completed;
    voiceTalkBtn.disabled = completed;
    gateStatus.textContent = completed
      ? "🔒 完了済み会議（閲覧専用）"
      : "待機中（マイク入力可能）";
  }
}

function applyMeetingEditableState(): void {
  const completed = isCurrentMeetingCompleted();
  $<HTMLElement>("completedGuardBanner").hidden = !completed;

  const lockControls: string[] = [
    "voiceTalkBtn",
    "continuousTalkCheck",
    "recordBtn",
    "timeCheckBtn",
    "summarizeBtn",
    "openAddBoardItemBtn",
    "addUtteranceBtn",
    "sampleUtteranceBtn",
    "askBtn",
  ];

  for (const id of lockControls) {
    const el = document.getElementById(id) as HTMLButtonElement | HTMLInputElement | null;
    if (el) {
      el.disabled = completed || (echoGateActive && (id === "recordBtn" || id === "voiceTalkBtn"));
    }
  }

  if (completed) {
    $<HTMLInputElement>("continuousTalkCheck").checked = false;
  }

  $<HTMLParagraphElement>("echoGateStatus").textContent = completed
    ? "🔒 完了済み会議（閲覧専用）"
    : echoGateActive
      ? "🔇 AI発話中（自己音声エコー抑止ゲート作動中）"
      : "待機中（マイク入力可能）";

  updateHintVisibility("idle");
  renderBoard(currentBoard);
}

async function playFacilitatorVoice(
  text: string,
  audioUrl: string | null,
  onComplete?: () => void,
): Promise<void> {
  $<HTMLParagraphElement>("subtitleText").textContent = text;
  if (!soundEnabled) {
    avatar.setState("idle");
    if (onComplete) onComplete();
    return;
  }

  setEchoGate(true);
  avatar.setState("speaking");

  const releaseGateAfterTail = () => {
    window.setTimeout(() => {
      setEchoGate(false);
      avatar.setState("idle");
      if (onComplete) onComplete();
    }, ECHO_TAIL_GUARD_MS);
  };

  if (audioUrl) {
    try {
      const audioEl = new Audio(audioUrl);
      audioEl.onended = releaseGateAfterTail;
      audioEl.onerror = releaseGateAfterTail;
      await audioEl.play();
      return;
    } catch {
      // VOICEVOX再生失敗時はブラウザ標準音声へフォールバック
    }
  }

  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
    const uttr = new SpeechSynthesisUtterance(text);
    uttr.lang = "ja-JP";
    uttr.onend = releaseGateAfterTail;
    uttr.onerror = releaseGateAfterTail;
    window.speechSynthesis.speak(uttr);
  } else {
    releaseGateAfterTail();
  }
}

function openBoardItemModal(item?: BoardItem): void {
  if (isCurrentMeetingCompleted()) {
    showToast("完了済みの会議は編集できません。", "error");
    return;
  }
  const titleEl = $<HTMLHeadingElement>("addBoardDialogTitle");
  const catSelect = $<HTMLSelectElement>("manualCategory");
  const contentInput = $<HTMLInputElement>("manualContent");
  const lockCheck = $<HTMLInputElement>("manualLockCheck");
  const submitBtn = $<HTMLButtonElement>("submitBoardItemBtn");

  if (item) {
    editingBoardItemId = item.id;
    titleEl.textContent = "議事ボード項目の編集";
    catSelect.value = item.category;
    contentInput.value = item.content;
    lockCheck.checked = item.is_locked;
    submitBtn.textContent = "💾 更新を保存";
  } else {
    editingBoardItemId = null;
    titleEl.textContent = "議事ボードへの手動追加";
    catSelect.value = "decisions";
    contentInput.value = "";
    lockCheck.checked = true;
    submitBtn.textContent = "🔒 ロック付きで追加";
  }
  $<HTMLDialogElement>("addBoardDialog").showModal();
  contentInput.focus();
}

async function toggleBoardItemLock(item: BoardItem): Promise<void> {
  if (!currentMeetingId || isCurrentMeetingCompleted()) return;
  try {
    const res = await apiJson<{ board: BoardMap }>(
      `/api/meetings/${currentMeetingId}/board-items`,
      {
        method: "PATCH",
        body: JSON.stringify({
          item_id: item.id,
          category: item.category,
          content: item.content,
          is_locked: !item.is_locked,
        }),
      },
    );
    currentBoard = res.board;
    renderBoard(currentBoard);
    showToast(
      !item.is_locked ? "項目を保護ロックしました。" : "項目の保護ロックを解除しました。",
      "info",
    );
  } catch (err) {
    showToast((err as Error).message, "error");
  }
}

async function deleteBoardItem(item: BoardItem): Promise<void> {
  if (!currentMeetingId || isCurrentMeetingCompleted()) return;
  try {
    const res = await apiJson<{ board: BoardMap }>(
      `/api/meetings/${currentMeetingId}/board-items/${item.id}`,
      { method: "DELETE" },
    );
    currentBoard = res.board;
    renderBoard(currentBoard);
    showToast("ボード項目を削除しました。", "info");
  } catch (err) {
    showToast((err as Error).message, "error");
  }
}

function renderBoardCard(ulId: string, items: BoardItem[], emptyText: string): void {
  const ul = $<HTMLUListElement>(ulId);
  ul.replaceChildren();
  if (!items || items.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-hint";
    li.textContent = emptyText;
    ul.appendChild(li);
    return;
  }

  const completed = isCurrentMeetingCompleted();

  for (const item of items) {
    const li = document.createElement("li");
    li.className = "board-item-row";

    const body = document.createElement("div");
    body.className = "board-item-body";

    if (item.carried_over) {
      const badge = document.createElement("span");
      badge.className = "item-tag";
      badge.textContent = "前回引継";
      body.appendChild(badge);
    }
    if (item.is_locked) {
      const lockBadge = document.createElement("span");
      lockBadge.className = "item-tag";
      lockBadge.textContent = "🔒保護";
      body.appendChild(lockBadge);
    }
    body.appendChild(document.createTextNode(item.content));
    li.appendChild(body);

    if (!completed) {
      const actions = document.createElement("div");
      actions.className = "board-item-actions";

      const lockBtn = document.createElement("button");
      lockBtn.type = "button";
      lockBtn.className = "btn-item-action";
      lockBtn.textContent = item.is_locked ? "🔓" : "🔒";
      lockBtn.setAttribute(
        "aria-label",
        item.is_locked ? `${item.content} の保護を解除` : `${item.content} を保護ロック`,
      );
      lockBtn.addEventListener("click", () => toggleBoardItemLock(item));

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "btn-item-action";
      editBtn.textContent = "✏️";
      editBtn.setAttribute("aria-label", `${item.content} を編集`);
      editBtn.addEventListener("click", () => openBoardItemModal(item));

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn-item-action btn-item-delete";
      delBtn.textContent = "🗑️";
      delBtn.setAttribute("aria-label", `${item.content} を削除`);
      delBtn.addEventListener("click", () => deleteBoardItem(item));

      actions.append(lockBtn, editBtn, delBtn);
      li.appendChild(actions);
    }

    ul.appendChild(li);
  }
}

function renderBoard(board: BoardMap): void {
  renderBoardCard("listDecisions", board.decisions, "まだ決定事項はありません");
  renderBoardCard("listRequests", board.requests, "まだ要望はありません");
  renderBoardCard("listMaterials", board.waiting_materials, "まだ素材待ちはありません");
  renderBoardCard("listUndecided", board.undecided, "まだ未決定事項はありません");

  $<HTMLSpanElement>("boardCountsText").textContent =
    `決${board.decisions.length}・要${board.requests.length}・素${board.waiting_materials.length}・未${board.undecided.length}`;

  if (board.undecided.length > 0) {
    $<HTMLElement>("nextFocusText").textContent =
      `未決定 ${board.undecided.length}件：${board.undecided[0].content}`;
  } else if (board.waiting_materials.length > 0) {
    $<HTMLElement>("nextFocusText").textContent =
      `素材待ち ${board.waiting_materials.length}件：${board.waiting_materials[0].content}`;
  } else {
    $<HTMLElement>("nextFocusText").textContent = "発言を聞き取りながら論点を整理します";
  }
}

function renderUtterances(utterances: Utterance[]): void {
  const recentOl = $<HTMLOListElement>("recentTranscriptList");
  recentOl.replaceChildren();
  const recentSlice = utterances.slice(-RECENT_HUD_COUNT);
  if (recentSlice.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-hint";
    li.textContent = "（まだ会話ログはありません。マイクで話すとここに表示されます）";
    recentOl.appendChild(li);
  } else {
    for (const u of recentSlice) {
      const li = document.createElement("li");
      const icon = u.source === "stt" ? "🎤" : "⌨️";
      li.textContent = `${icon} ${u.speaker}: ${u.text}`;
      recentOl.appendChild(li);
    }
  }

  const fullOl = $<HTMLOListElement>("transcriptList");
  fullOl.replaceChildren();
  if (utterances.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-hint";
    li.textContent = "音声録音またはテキスト入力で発言を記録します";
    fullOl.appendChild(li);
    return;
  }
  for (const u of utterances) {
    const li = document.createElement("li");
    const srcTag = u.source === "stt" ? "🎤" : "⌨️";
    li.textContent = `${srcTag} [${u.speaker}] ${u.text}`;
    fullOl.appendChild(li);
  }
  fullOl.scrollTop = fullOl.scrollHeight;
}

function appendUtteranceLocal(utterance: Utterance): void {
  if (!currentUtterances.some((u) => u.id === utterance.id)) {
    currentUtterances.push(utterance);
    renderUtterances(currentUtterances);
  }
}

function extractNextActions(markdown: string, board?: BoardMap): string[] {
  const lines = markdown.split(/\r?\n/);
  const actions: string[] = [];
  let inSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("## ")) {
      inSection = line === "## ネクストアクション";
      continue;
    }
    if (inSection && line.startsWith("- ")) {
      const text = line.slice(2).trim();
      if (text && text !== "なし") {
        actions.push(text);
      }
    }
  }
  if (actions.length > 0) return actions;
  if (board) {
    return [
      ...board.waiting_materials.map((item) => `【素材支給】${item.content}`),
      ...board.undecided.map((item) => `【要確認】${item.content}`),
    ];
  }
  return [];
}

function openReportModal(
  markdown: string,
  nextActions?: string[],
  board?: BoardMap,
): void {
  const resolvedActions =
    nextActions && nextActions.length > 0 ? nextActions : extractNextActions(markdown, board);

  const ul = $<HTMLUListElement>("nextActionsList");
  ul.replaceChildren();
  if (resolvedActions.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-hint";
    li.textContent = "ネクストアクションの登録はありません";
    ul.appendChild(li);
  } else {
    for (const act of resolvedActions) {
      const li = document.createElement("li");
      li.textContent = act;
      ul.appendChild(li);
    }
  }

  const mdOut = $<HTMLTextAreaElement>("markdownOutput");
  mdOut.value = markdown || "（議事録データがありません）";

  const dialog = $<HTMLDialogElement>("reportDialog");
  dialog.showModal();
  mdOut.scrollTop = 0;
  mdOut.setSelectionRange(0, 0);
  window.requestAnimationFrame(() => {
    mdOut.scrollTop = 0;
  });
  $<HTMLButtonElement>("closeReportDialogBtn").focus();
}

function connectMeetingSocket(meetingId: string): void {
  if (currentSocket) {
    currentSocket.close();
    currentSocket = null;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${window.location.host}/ws/meetings/${meetingId}`);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.event === "utterance.created" && msg.data?.utterance) {
        appendUtteranceLocal(msg.data.utterance as Utterance);
      } else if (msg.event === "board.updated" && msg.data?.board) {
        currentBoard = msg.data.board as BoardMap;
        renderBoard(currentBoard);
      } else if (msg.event === "avatar.state" && msg.data?.state && !echoGateActive) {
        avatar.setState(msg.data.state);
      } else if (msg.event === "facilitator.speak" && msg.data && !localVoiceActionInFlight) {
        if (msg.data.spoken_message) {
          $<HTMLParagraphElement>("subtitleText").textContent = String(msg.data.spoken_message);
        }
        if (msg.data.next_focus) {
          $<HTMLElement>("nextFocusText").textContent = String(msg.data.next_focus);
        }
      } else if (msg.event === "meeting.completed" && currentMeeting) {
        currentMeeting.status = "completed";
        if (typeof msg.data?.summary_markdown === "string") {
          currentMeeting.summary_markdown = msg.data.summary_markdown;
        }
        applyMeetingEditableState();
      }
    } catch {
      // ignore malformed frames
    }
  };
  currentSocket = ws;
}

async function refreshHealth(): Promise<void> {
  const h = await apiJson<{
    ollama: { connected: boolean; models: string[] };
    voicevox: { connected: boolean; version?: string };
    has_custom_videos: boolean;
  }>("/api/health");

  ollamaConnected = h.ollama.connected;
  avatar.setUseCustomVideos(h.has_custom_videos);

  const ollamaClass = ollamaConnected ? "hud-chip badge-ok" : "hud-chip badge-warn";
  const ollamaText = ollamaConnected ? "🟢 LLM接続中" : "🟡 デモモード";
  const vvClass = h.voicevox.connected ? "hud-chip badge-ok" : "hud-chip badge-warn";
  const vvText = h.voicevox.connected ? "🟢 VOICEVOX" : "🟡 標準音声";

  for (const id of ["ollamaBadge", "lobbyOllamaBadge"]) {
    const el = document.getElementById(id);
    if (el) {
      el.className = ollamaClass;
      el.textContent = ollamaText;
    }
  }
  for (const id of ["voicevoxBadge", "lobbyVoicevoxBadge"]) {
    const el = document.getElementById(id);
    if (el) {
      el.className = vvClass;
      el.textContent = vvText;
    }
  }

  $<HTMLSpanElement>("ollamaDot").className = ollamaConnected
    ? "health-dot dot-ok"
    : "health-dot dot-warn";
  $<HTMLSpanElement>("voicevoxDot").className = h.voicevox.connected
    ? "health-dot dot-ok"
    : "health-dot dot-warn";
  $<HTMLSpanElement>("stageHealthDots").setAttribute(
    "aria-label",
    `${ollamaText} / ${vvText}`,
  );

  const dl = $<HTMLDataListElement>("modelList");
  dl.replaceChildren();
  for (const m of h.ollama.models) {
    const opt = document.createElement("option");
    opt.value = m;
    dl.appendChild(opt);
  }
  const modelInput = $<HTMLInputElement>("modelInput");
  if (h.ollama.models.length > 0 && !h.ollama.models.includes(modelInput.value)) {
    modelInput.value = h.ollama.models[0];
  }
}

function updateCarryOverHintForProject(projectId: string): void {
  const label = $<HTMLElement>("lobbyCarryOverLabel");
  const titleInput = $<HTMLInputElement>("lobbyMeetingTitle");
  const projectMeetings = lobbyMeetings.filter((m) => m.project_id === projectId);
  const latest = projectMeetings[0];
  if (latest && latest.board_counts) {
    const mat = latest.board_counts.waiting_materials || 0;
    const und = latest.board_counts.undecided || 0;
    label.textContent = `前回会議の「素材待ち（${mat}件）」「未決定事項（${und}件）」を初期ボードへ自動引き継ぎする`;
  } else {
    label.textContent = "前回会議の「素材待ち」「未決定事項」を初期ボードへ自動引き継ぎする";
  }

  const nextNo = projectMeetings.length + 1;
  if (!titleInput.dataset.userEdited) {
    titleInput.value = `第${nextNo}回 デザイン・仕様確認打ち合わせ`;
  }
}

function formatDateTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso.slice(0, 16);
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, "0");
  const d = String(parsed.getDate()).padStart(2, "0");
  const hh = String(parsed.getHours()).padStart(2, "0");
  const mm = String(parsed.getMinutes()).padStart(2, "0");
  return `${y}/${m}/${d} ${hh}:${mm}`;
}

function renderLobbyMeetings(): void {
  const projectFilter = $<HTMLSelectElement>("lobbyFilterProjectSelect").value;
  const projectFiltered = projectFilter
    ? lobbyMeetings.filter((m) => m.project_id === projectFilter)
    : lobbyMeetings;

  const activeCount = projectFiltered.filter((m) => m.status !== "completed").length;
  const completedCount = projectFiltered.filter((m) => m.status === "completed").length;

  $<HTMLButtonElement>("filterAllBtn").textContent = `すべて (${projectFiltered.length})`;
  $<HTMLButtonElement>("filterActiveBtn").textContent = `🟢 進行中 (${activeCount})`;
  $<HTMLButtonElement>("filterCompletedBtn").textContent = `⚪ 完了済み (${completedCount})`;

  for (const btnId of ["filterAllBtn", "filterActiveBtn", "filterCompletedBtn"]) {
    const btn = $<HTMLButtonElement>(btnId);
    btn.setAttribute("aria-pressed", String(btn.dataset.status === lobbyStatusFilter));
  }

  const visible = projectFiltered.filter((m) => {
    if (lobbyStatusFilter === "active") return m.status !== "completed";
    if (lobbyStatusFilter === "completed") return m.status === "completed";
    return true;
  });

  const list = $<HTMLUListElement>("lobbyMeetingList");
  list.replaceChildren();

  if (visible.length === 0) {
    const emptyLi = document.createElement("li");
    emptyLi.className = "lobby-empty";
    emptyLi.textContent = "該当する会議はありません。左のフォームから新しい会議を作成できます。";
    list.appendChild(emptyLi);
    return;
  }

  for (const m of visible) {
    const isCompleted = m.status === "completed";
    const li = document.createElement("li");
    li.className = `lobby-meeting-card ${isCompleted ? "is-completed" : "is-active"}`;

    const main = document.createElement("div");
    main.className = "lobby-card-main";

    const meta = document.createElement("div");
    meta.className = "lobby-card-meta";

    const statusPill = document.createElement("span");
    statusPill.className = `status-pill ${isCompleted ? "is-completed" : "is-active"}`;
    statusPill.textContent = isCompleted ? "✓ 完了済み" : "● 進行中";

    const projectLabel = [m.client_name, m.project_name].filter(Boolean).join("｜") || "案件";
    const metaText = document.createElement("span");
    metaText.textContent = `${projectLabel} ・ ${formatDateTime(m.started_at)}（予定 ${m.duration_minutes}分）`;

    meta.append(statusPill, metaText);

    const title = document.createElement("h3");
    title.className = "lobby-card-title";
    title.textContent = m.title;

    const counts = m.board_counts || {
      decisions: 0,
      requests: 0,
      waiting_materials: 0,
      undecided: 0,
    };
    const summary = document.createElement("p");
    summary.className = "lobby-card-summary";
    summary.textContent = `決定 ${counts.decisions}件 ・ 要望 ${counts.requests}件 ・ 素材待ち ${counts.waiting_materials}件 ・ 未決定 ${counts.undecided}件（発言 ${m.utterance_count ?? 0}件）`;

    main.append(meta, title, summary);

    const actions = document.createElement("div");
    actions.className = "lobby-card-actions";

    if (isCompleted) {
      const reportBtn = document.createElement("button");
      reportBtn.type = "button";
      reportBtn.className = "btn-view-minutes";
      reportBtn.textContent = "📄 議事録を見る";
      reportBtn.addEventListener("click", async () => {
        try {
          const detail = await apiJson<{
            meeting: MeetingSummaryInfo;
            board: BoardMap;
          }>(`/api/meetings/${m.id}`);
          openReportModal(detail.meeting.summary_markdown, undefined, detail.board);
        } catch (err) {
          showToast((err as Error).message, "error");
        }
      });

      const inspectBtn = document.createElement("button");
      inspectBtn.type = "button";
      inspectBtn.className = "btn-secondary-dark";
      inspectBtn.textContent = "ステージ閲覧";
      inspectBtn.addEventListener("click", () => enterMeetingStage(m.id));

      actions.append(reportBtn, inspectBtn);
    } else {
      const resumeBtn = document.createElement("button");
      resumeBtn.type = "button";
      resumeBtn.className = "btn-resume";
      resumeBtn.textContent = "▶ 途中から再開";
      resumeBtn.addEventListener("click", () => enterMeetingStage(m.id));
      actions.appendChild(resumeBtn);
    }

    li.append(main, actions);
    list.appendChild(li);
  }
}

async function loadLobbyData(preferredProjectId?: string): Promise<void> {
  const [{ projects }, { meetings }] = await Promise.all([
    apiJson<{ projects: ProjectInfo[] }>("/api/projects"),
    apiJson<{ meetings: MeetingSummaryInfo[] }>("/api/meetings"),
  ]);

  lobbyMeetings = meetings;

  const createProjectSel = $<HTMLSelectElement>("lobbyProjectSelect");
  const filterProjectSel = $<HTMLSelectElement>("lobbyFilterProjectSelect");
  const prevCreateVal = preferredProjectId || createProjectSel.value;
  const prevFilterVal = filterProjectSel.value;

  createProjectSel.replaceChildren();
  filterProjectSel.replaceChildren();

  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "すべての案件";
  filterProjectSel.appendChild(allOpt);

  for (const p of projects) {
    const label = [p.client_name, p.name].filter(Boolean).join("｜") || p.name;
    const opt1 = document.createElement("option");
    opt1.value = p.id;
    opt1.textContent = label;
    createProjectSel.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = p.id;
    opt2.textContent = label;
    filterProjectSel.appendChild(opt2);
  }

  if (projects.some((p) => p.id === prevCreateVal)) {
    createProjectSel.value = prevCreateVal;
  } else if (projects.length > 0) {
    createProjectSel.value = projects[0].id;
  }

  if (projects.some((p) => p.id === prevFilterVal)) {
    filterProjectSel.value = prevFilterVal;
  }

  if (createProjectSel.value) {
    updateCarryOverHintForProject(createProjectSel.value);
  }
  renderLobbyMeetings();
}

function stopActiveAudioAndSockets(): void {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }
  if (voiceTalkRecorder && voiceTalkRecorder.state === "recording") {
    voiceTalkRecorder.stop();
  }
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  if (currentSocket) {
    currentSocket.close();
    currentSocket = null;
  }
}

function showAuthView(): void {
  stopActiveAudioAndSockets();
  $<HTMLElement>("lobbyView").hidden = true;
  $<HTMLElement>("appView").hidden = true;
  $<HTMLElement>("authView").hidden = false;
}

async function enterLobbyView(preferredProjectId?: string): Promise<void> {
  stopActiveAudioAndSockets();
  $<HTMLElement>("authView").hidden = true;
  $<HTMLElement>("appView").hidden = true;
  $<HTMLElement>("lobbyView").hidden = false;
  await Promise.all([refreshHealth(), loadLobbyData(preferredProjectId)]);
}

async function selectMeeting(meetingId: string): Promise<void> {
  currentMeetingId = meetingId;
  const detail = await apiJson<{
    meeting: MeetingSummaryInfo;
    utterances: Utterance[];
    board: BoardMap;
  }>(`/api/meetings/${meetingId}`);

  currentMeeting = detail.meeting;
  currentProjectId = detail.meeting.project_id;
  currentUtterances = detail.utterances;
  currentBoard = detail.board;

  $<HTMLSpanElement>("projectLabel").textContent =
    `${detail.meeting.client_name || ""} ${detail.meeting.project_name || ""}`.trim() || "案件";
  $<HTMLHeadingElement>("meetingTitleHeading").textContent = detail.meeting.title;
  $<HTMLParagraphElement>("meetingAgendaText").textContent = detail.meeting.agenda;
  $<HTMLInputElement>("remainingInput").value = String(detail.meeting.duration_minutes || 45);

  renderUtterances(currentUtterances);
  applyMeetingEditableState();
  connectMeetingSocket(meetingId);
}

async function enterMeetingStage(meetingId: string): Promise<void> {
  hasStartedDialogue = false;
  $<HTMLElement>("authView").hidden = true;
  $<HTMLElement>("lobbyView").hidden = true;
  $<HTMLElement>("appView").hidden = false;

  if (!avatarMounted) {
    await avatar.mount($<HTMLElement>("avatarMount"));
    avatarMounted = true;
  }
  await refreshHealth();
  await selectMeeting(meetingId);

  $<HTMLParagraphElement>("userHeardText").hidden = true;
  $<HTMLParagraphElement>("subtitleText").textContent =
    currentMeeting?.status === "completed"
      ? "この会議は完了済みです。右のボード・ログから記録内容を確認できます。"
      : "こんにちは。会議の発言を記録しながら、論点整理と最後のまとめを担当します。";
}

async function toggleRecording(): Promise<void> {
  if (echoGateActive || isCurrentMeetingCompleted() || !currentMeetingId) return;
  const recordBtn = $<HTMLButtonElement>("recordBtn");
  const hint = $<HTMLParagraphElement>("voiceTalkHint");

  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      recordBtn.classList.remove("recording");
      recordBtn.textContent = "🎤 発言のみ記録";
      hint.hidden = false;
      hint.textContent = "Whisperで文字起こし ＆ ボード整理中...";
      avatar.setState("thinking");

      const blob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
      const fd = new FormData();
      fd.append("file", blob, "utterance.webm");
      fd.append("speaker", $<HTMLSelectElement>("speakerSelect").value);
      fd.append("model", $<HTMLInputElement>("modelInput").value.trim());
      fd.append("use_mock", String(shouldUseMock()));

      try {
        const res = await apiJson<{
          skipped?: boolean;
          transcribed_text: string;
          utterance?: Utterance;
          board?: BoardMap;
        }>(`/api/meetings/${currentMeetingId}/audio`, { method: "POST", body: fd });

        if (!res.skipped) {
          if (res.utterance) appendUtteranceLocal(res.utterance);
          if (res.board) {
            currentBoard = res.board;
            renderBoard(currentBoard);
          }
        }
        hint.textContent = res.transcribed_text
          ? `記録完了: 「${res.transcribed_text}」`
          : "無音のためスキップしました";
      } catch (err) {
        showToast((err as Error).message, "error");
        hint.textContent = "文字起こしエラー";
      } finally {
        avatar.setState("idle");
      }
    };

    mediaRecorder.start();
    avatar.setState("listening");
    recordBtn.classList.add("recording");
    recordBtn.textContent = "⏹ 記録停止して送信";
    hint.hidden = false;
    hint.textContent = "🔴 会議発言を録音中... もう一度「記録停止」を押すと議事ボードへ反映します";
  } catch {
    showToast("マイクへのアクセスを許可してください。", "error");
  }
}

async function startOrStopVoiceConversation(): Promise<void> {
  if (echoGateActive || isCurrentMeetingCompleted() || !currentMeetingId) return;

  const btn = $<HTMLButtonElement>("voiceTalkBtn");
  const hint = $<HTMLParagraphElement>("voiceTalkHint");
  const heardLine = $<HTMLParagraphElement>("userHeardText");

  if (voiceTalkRecorder && voiceTalkRecorder.state === "recording") {
    voiceTalkRecorder.stop();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    const audioCtx = new AudioContext();
    await audioCtx.resume();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const pcm = new Float32Array(analyser.fftSize);

    const chunks: BlobPart[] = [];
    const rec = new MediaRecorder(stream);
    voiceTalkRecorder = rec;

    let hasSpoken = false;
    let timedOutSilence = false;
    let silenceStart = 0;
    const recordStartedAt = performance.now();
    let monitorTimer = 0;

    const stopMonitor = () => {
      if (monitorTimer) {
        window.clearInterval(monitorTimer);
        monitorTimer = 0;
      }
      audioCtx.close().catch(() => {});
      stream.getTracks().forEach((t) => t.stop());
    };

    monitorTimer = window.setInterval(() => {
      if (rec.state !== "recording") return;
      analyser.getFloatTimeDomainData(pcm);
      let sumSq = 0;
      for (let i = 0; i < pcm.length; i += 1) {
        sumSq += pcm[i] * pcm[i];
      }
      const rms = Math.sqrt(sumSq / pcm.length);
      const now = performance.now();

      if (rms > 0.015) {
        hasSpoken = true;
        silenceStart = 0;
        hint.textContent = "🗣️ 聞き取り中...（話し終えて1秒ほど待つと自動送信します）";
      } else if (hasSpoken) {
        if (silenceStart === 0) {
          silenceStart = now;
        } else if (now - silenceStart > 1200) {
          rec.stop();
        }
      } else if (now - recordStartedAt > 8000) {
        timedOutSilence = true;
        rec.stop();
      }
    }, 100);

    rec.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.push(ev.data);
    };

    rec.onstop = async () => {
      stopMonitor();
      voiceTalkRecorder = null;
      btn.classList.remove("listening");
      btn.textContent = "🎙️ 声でAIと話す";

      if (timedOutSilence || chunks.length === 0) {
        avatar.setState("idle");
        hint.hidden = false;
        hint.textContent = "音声が検出されませんでした。「声でAIと話す」を押して話しかけてください。";
        return;
      }

      hasStartedDialogue = true;
      localVoiceActionInFlight = true;
      avatar.setState("thinking");
      btn.disabled = true;
      hint.hidden = false;
      hint.textContent = "🧠 Whisperで音声認識 ＆ AI返答を作成中...";

      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      const fd = new FormData();
      fd.append("file", blob, "voice-talk.webm");
      fd.append(
        "remaining_minutes",
        String(Number($<HTMLInputElement>("remainingInput").value) || 15),
      );
      fd.append("model", $<HTMLInputElement>("modelInput").value.trim());
      fd.append("use_mock", String(shouldUseMock()));

      try {
        const res = await apiJson<{
          skipped: boolean;
          is_summary?: boolean;
          transcribed_text: string;
          utterance?: Utterance;
          spoken_message?: string;
          next_focus?: string;
          next_actions?: string[];
          markdown_report?: string;
          audio_url?: string | null;
          board?: BoardMap;
        }>(`/api/meetings/${currentMeetingId}/voice-chat`, {
          method: "POST",
          body: fd,
        });

        btn.disabled = isCurrentMeetingCompleted();

        if (res.skipped || !res.transcribed_text) {
          localVoiceActionInFlight = false;
          avatar.setState("idle");
          hint.hidden = false;
          hint.textContent = "無音のためスキップしました。もう一度話しかけてください。";
          return;
        }

        heardLine.hidden = false;
        heardLine.textContent = `あなた: 「${res.transcribed_text}」`;
        if (res.next_focus) {
          $<HTMLElement>("nextFocusText").textContent = res.next_focus;
        }
        if (res.utterance) {
          appendUtteranceLocal(res.utterance);
        }
        if (res.board) {
          currentBoard = res.board;
          renderBoard(currentBoard);
        }

        if (res.is_summary && currentMeeting) {
          currentMeeting.status = "completed";
          currentMeeting.summary_markdown = res.markdown_report || "";
          applyMeetingEditableState();
          openReportModal(
            res.markdown_report || "",
            res.next_actions,
            currentBoard,
          );
        }

        hint.textContent = "🔊 AIファシリテーターが発話中...";
        await playFacilitatorVoice(res.spoken_message || "", res.audio_url || null, () => {
          localVoiceActionInFlight = false;
          if ($<HTMLInputElement>("continuousTalkCheck").checked && !isCurrentMeetingCompleted()) {
            startOrStopVoiceConversation();
          }
        });
      } catch (err) {
        localVoiceActionInFlight = false;
        btn.disabled = isCurrentMeetingCompleted();
        avatar.setState("idle");
        hint.hidden = false;
        hint.textContent = "音声対話エラーが発生しました";
        showToast((err as Error).message, "error");
      }
    };

    rec.start();
    avatar.setState("listening");
    btn.classList.add("listening");
    btn.textContent = "⏹ 聞き取り中（クリックで即送信）";
    hint.hidden = false;
    hint.textContent = "🎤 話しかけてください（例：「こんにちは」「未決定事項を教えて」「会議を締めてください」）";
  } catch {
    showToast("マイクの使用をブラウザで「許可」してください。", "error");
  }
}

function bindEvents(): void {
  installDialogLightDismissFallback();

  // SCR-01: ログインフォーム
  const passInput = $<HTMLInputElement>("current-password");
  const togglePassBtn = $<HTMLButtonElement>("togglePasscodeBtn");
  const loginError = $<HTMLParagraphElement>("login-error");
  const loginSubmitBtn = $<HTMLButtonElement>("loginSubmitBtn");

  passInput.addEventListener("input", () => {
    loginError.hidden = true;
  });

  togglePassBtn.addEventListener("click", () => {
    const showing = passInput.type === "text";
    passInput.type = showing ? "password" : "text";
    togglePassBtn.setAttribute("aria-pressed", String(!showing));
    togglePassBtn.textContent = showing ? "表示" : "隠す";
  });

  $<HTMLFormElement>("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    loginSubmitBtn.disabled = true;
    try {
      await apiJson("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ passcode: passInput.value }),
      });
      passInput.value = "";
      await enterLobbyView();
    } catch (err) {
      loginError.textContent = (err as Error).message;
      loginError.hidden = false;
      passInput.focus();
    } finally {
      loginSubmitBtn.disabled = false;
    }
  });

  // SCR-02: 会議ロビーイベント
  const lobbyProjectSel = $<HTMLSelectElement>("lobbyProjectSelect");
  const lobbyTitleInput = $<HTMLInputElement>("lobbyMeetingTitle");
  lobbyTitleInput.addEventListener("input", () => {
    lobbyTitleInput.dataset.userEdited = "1";
  });

  lobbyProjectSel.addEventListener("change", () => {
    updateCarryOverHintForProject(lobbyProjectSel.value);
  });

  $<HTMLSelectElement>("lobbyFilterProjectSelect").addEventListener("change", renderLobbyMeetings);
  for (const btnId of ["filterAllBtn", "filterActiveBtn", "filterCompletedBtn"]) {
    $<HTMLButtonElement>(btnId).addEventListener("click", (e) => {
      const target = e.currentTarget as HTMLButtonElement;
      lobbyStatusFilter = (target.dataset.status as "all" | "active" | "completed") || "all";
      renderLobbyMeetings();
    });
  }

  $<HTMLFormElement>("lobbyCreateMeetingForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const startBtn = $<HTMLButtonElement>("lobbyStartMeetingBtn");
    const title = lobbyTitleInput.value.trim();
    if (!title) {
      showToast("会議タイトルを入力してください。", "error");
      lobbyTitleInput.focus();
      return;
    }
    const durationRadio = document.querySelector<HTMLInputElement>(
      'input[name="duration_minutes"]:checked',
    );
    const durationMinutes = Number(durationRadio?.value || "45");

    startBtn.disabled = true;
    try {
      const res = await apiJson<{ meeting: MeetingSummaryInfo }>("/api/meetings", {
        method: "POST",
        body: JSON.stringify({
          project_id: lobbyProjectSel.value,
          title,
          agenda: $<HTMLTextAreaElement>("lobbyMeetingAgenda").value.trim(),
          duration_minutes: durationMinutes,
          carry_over: $<HTMLInputElement>("lobbyCarryOverCheck").checked,
        }),
      });
      delete lobbyTitleInput.dataset.userEdited;
      await enterMeetingStage(res.meeting.id);
      showToast("会議室モニターを開始しました。", "success");
    } catch (err) {
      showToast((err as Error).message, "error");
    } finally {
      startBtn.disabled = false;
    }
  });

  // MDL-03: 新規案件作成モーダル
  const newProjectDialog = $<HTMLDialogElement>("newProjectDialog");
  $<HTMLButtonElement>("openNewProjectBtn").addEventListener("click", () => {
    newProjectDialog.showModal();
    $<HTMLInputElement>("newProjectName").focus();
  });
  $<HTMLButtonElement>("cancelNewProjectBtn").addEventListener("click", () => {
    newProjectDialog.close();
  });
  $<HTMLFormElement>("newProjectForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = $<HTMLButtonElement>("submitNewProjectBtn");
    const nameInput = $<HTMLInputElement>("newProjectName");
    const clientInput = $<HTMLInputElement>("newProjectClient");
    const name = nameInput.value.trim();
    if (!name) {
      showToast("案件名を入力してください。", "error");
      nameInput.focus();
      return;
    }

    submitBtn.disabled = true;
    try {
      const res = await apiJson<{ project: ProjectInfo }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name,
          client_name: clientInput.value.trim(),
        }),
      });
      nameInput.value = "";
      clientInput.value = "";
      newProjectDialog.close();
      await loadLobbyData(res.project.id);
      showToast(`案件「${res.project.name}」を登録しました。`, "success");
    } catch (err) {
      showToast((err as Error).message, "error");
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ログアウト（ロビー／設定ドロワー共通）
  const handleLogout = async () => {
    try {
      await apiJson("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    const settingsDrawer = $<HTMLDialogElement>("settingsDrawer");
    if (settingsDrawer.open) settingsDrawer.close();
    showAuthView();
  };
  $<HTMLButtonElement>("lobbyLogoutBtn").addEventListener("click", handleLogout);
  $<HTMLButtonElement>("logoutBtn").addEventListener("click", handleLogout);

  // SCR-03: ロビー戻り導線
  const goBackToLobby = () => {
    const settingsDrawer = $<HTMLDialogElement>("settingsDrawer");
    if (settingsDrawer.open) settingsDrawer.close();
    enterLobbyView(currentProjectId);
  };
  $<HTMLButtonElement>("backToLobbyBtn").addEventListener("click", goBackToLobby);
  $<HTMLButtonElement>("drawerBackToLobbyBtn").addEventListener("click", goBackToLobby);
  $<HTMLButtonElement>("bannerCreateNextBtn").addEventListener("click", goBackToLobby);

  $<HTMLButtonElement>("bannerViewReportBtn").addEventListener("click", () => {
    if (currentMeeting) {
      openReportModal(currentMeeting.summary_markdown, undefined, currentBoard);
    }
  });

  // サイドドロワー開閉
  const boardDrawer = $<HTMLDialogElement>("boardDrawer");
  const logDrawer = $<HTMLDialogElement>("logDrawer");
  const settingsDrawer = $<HTMLDialogElement>("settingsDrawer");

  $<HTMLButtonElement>("openBoardDrawerBtn").addEventListener("click", () => boardDrawer.showModal());
  $<HTMLButtonElement>("topBoardBtn").addEventListener("click", () => boardDrawer.showModal());
  $<HTMLButtonElement>("openLogDrawerBtn").addEventListener("click", () => logDrawer.showModal());
  $<HTMLButtonElement>("inlineOpenLogBtn").addEventListener("click", () => logDrawer.showModal());
  $<HTMLButtonElement>("openSettingsDrawerBtn").addEventListener("click", () => settingsDrawer.showModal());

  $<HTMLButtonElement>("soundToggleBtn").addEventListener("click", (e) => {
    soundEnabled = !soundEnabled;
    const btn = e.currentTarget as HTMLButtonElement;
    btn.setAttribute("aria-pressed", String(soundEnabled));
    btn.textContent = soundEnabled ? "🔊 音声読み上げ ON" : "🔇 音声読み上げ OFF";
  });

  $<HTMLButtonElement>("sampleUtteranceBtn").addEventListener("click", () => {
    const s = SAMPLES[sampleIdx % SAMPLES.length];
    sampleIdx += 1;
    $<HTMLSelectElement>("speakerSelect").value = s.speaker;
    $<HTMLTextAreaElement>("utteranceInput").value = s.text;
  });

  $<HTMLButtonElement>("recordBtn").addEventListener("click", toggleRecording);
  $<HTMLButtonElement>("voiceTalkBtn").addEventListener("click", () => {
    startOrStopVoiceConversation();
  });

  $<HTMLFormElement>("utteranceForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isCurrentMeetingCompleted()) {
      showToast("完了済みの会議には発言を追加できません。", "error");
      return;
    }
    const input = $<HTMLTextAreaElement>("utteranceInput");
    const text = input.value.trim();
    if (!text || !currentMeetingId) return;

    const btn = $<HTMLButtonElement>("addUtteranceBtn");
    btn.disabled = true;
    avatar.setState("thinking");
    try {
      const res = await apiJson<{ utterance: Utterance; board: BoardMap }>(
        `/api/meetings/${currentMeetingId}/utterances`,
        {
          method: "POST",
          body: JSON.stringify({
            text,
            speaker: $<HTMLSelectElement>("speakerSelect").value,
            model: $<HTMLInputElement>("modelInput").value.trim(),
            use_mock: shouldUseMock(),
          }),
        },
      );
      input.value = "";
      appendUtteranceLocal(res.utterance);
      currentBoard = res.board;
      renderBoard(currentBoard);
      showToast("発言を記録し、議事ボードを更新しました。", "success");
    } catch (err) {
      showToast((err as Error).message, "error");
    } finally {
      btn.disabled = isCurrentMeetingCompleted();
      avatar.setState("idle");
    }
  });

  const triggerFacilitate = async (question: string) => {
    if (!currentMeetingId) return;
    if (isCurrentMeetingCompleted() && !question) {
      showToast("完了済みの会議では残り時間声かけを実行できません。", "error");
      return;
    }
    hasStartedDialogue = true;
    localVoiceActionInFlight = true;
    avatar.setState("thinking");
    try {
      const res = await apiJson<{
        spoken_message: string;
        next_focus: string;
        audio_url: string | null;
      }>(`/api/meetings/${currentMeetingId}/facilitate`, {
        method: "POST",
        body: JSON.stringify({
          remaining_minutes: Number($<HTMLInputElement>("remainingInput").value) || 15,
          question,
          model: $<HTMLInputElement>("modelInput").value.trim(),
          use_mock: shouldUseMock(),
        }),
      });
      $<HTMLElement>("nextFocusText").textContent = res.next_focus;
      await playFacilitatorVoice(res.spoken_message, res.audio_url, () => {
        localVoiceActionInFlight = false;
      });
    } catch (err) {
      localVoiceActionInFlight = false;
      avatar.setState("idle");
      showToast((err as Error).message, "error");
    }
  };

  $<HTMLButtonElement>("timeCheckBtn").addEventListener("click", () => triggerFacilitate(""));

  $<HTMLFormElement>("askForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (isCurrentMeetingCompleted()) {
      showToast("完了済みの会議ではAIへの質問送信はできません。", "error");
      return;
    }
    const askInput = $<HTMLInputElement>("askInput");
    const q = askInput.value.trim() || "ここまでの論点を整理してください";
    askInput.value = "";
    logDrawer.close();
    triggerFacilitate(q);
  });

  $<HTMLButtonElement>("summarizeBtn").addEventListener("click", async () => {
    if (!currentMeetingId || isCurrentMeetingCompleted()) return;
    hasStartedDialogue = true;
    localVoiceActionInFlight = true;
    avatar.setState("thinking");
    try {
      const res = await apiJson<{
        spoken_closing: string;
        next_actions: string[];
        markdown_report: string;
        audio_url: string | null;
      }>(`/api/meetings/${currentMeetingId}/summarize`, {
        method: "POST",
        body: JSON.stringify({
          model: $<HTMLInputElement>("modelInput").value.trim(),
          use_mock: shouldUseMock(),
        }),
      });

      if (currentMeeting) {
        currentMeeting.status = "completed";
        currentMeeting.summary_markdown = res.markdown_report;
      }
      applyMeetingEditableState();
      openReportModal(res.markdown_report, res.next_actions, currentBoard);

      await playFacilitatorVoice(res.spoken_closing, res.audio_url, () => {
        localVoiceActionInFlight = false;
      });
      showToast("会議を締め、確定議事録を保存しました。", "success");
    } catch (err) {
      localVoiceActionInFlight = false;
      avatar.setState("idle");
      showToast((err as Error).message, "error");
    }
  });

  // MDL-01: ボード手動追加・編集モーダル
  const addBoardDialog = $<HTMLDialogElement>("addBoardDialog");
  $<HTMLButtonElement>("openAddBoardItemBtn").addEventListener("click", () => openBoardItemModal());
  $<HTMLButtonElement>("cancelAddBoardBtn").addEventListener("click", () => addBoardDialog.close());
  $<HTMLFormElement>("addBoardForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentMeetingId || isCurrentMeetingCompleted()) return;
    const contentInput = $<HTMLInputElement>("manualContent");
    const submitBtn = $<HTMLButtonElement>("submitBoardItemBtn");
    const content = contentInput.value.trim();
    if (!content) {
      showToast("項目内容を入力してください。", "error");
      contentInput.focus();
      return;
    }

    submitBtn.disabled = true;
    try {
      const res = await apiJson<{ board: BoardMap }>(
        `/api/meetings/${currentMeetingId}/board-items`,
        {
          method: "PATCH",
          body: JSON.stringify({
            item_id: editingBoardItemId,
            category: $<HTMLSelectElement>("manualCategory").value,
            content,
            is_locked: $<HTMLInputElement>("manualLockCheck").checked,
          }),
        },
      );
      const wasEdit = Boolean(editingBoardItemId);
      editingBoardItemId = null;
      contentInput.value = "";
      addBoardDialog.close();
      currentBoard = res.board;
      renderBoard(currentBoard);
      showToast(wasEdit ? "ボード項目を更新しました。" : "ボード項目を追加しました。", "success");
    } catch (err) {
      showToast((err as Error).message, "error");
    } finally {
      submitBtn.disabled = false;
    }
  });

  // MDL-02: Markdown保存・コピー
  $<HTMLButtonElement>("downloadMdBtn").addEventListener("click", () => {
    const md = $<HTMLTextAreaElement>("markdownOutput").value;
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `minutes-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Markdownファイルをダウンロードしました。", "success");
  });

  $<HTMLButtonElement>("copyMdBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText($<HTMLTextAreaElement>("markdownOutput").value);
      btn.textContent = "✅ コピー完了";
      showToast("議事録をクリップボードにコピーしました。", "success");
      window.setTimeout(() => {
        btn.textContent = "📋 コピー";
      }, 1500);
    } catch {
      showToast("クリップボードへのコピーに失敗しました。", "error");
    }
  });
}

async function boot(): Promise<void> {
  bindEvents();
  try {
    const me = await apiJson<{ authenticated: boolean }>("/api/auth/me");
    if (me.authenticated) {
      await enterLobbyView();
    }
  } catch {
    // show login screen
  }
}

boot();
