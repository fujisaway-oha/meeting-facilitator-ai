import {
  apiJson,
  type BoardItem,
  type BoardMap,
  type MeetingSummaryInfo,
  type Utterance,
} from "./api/client";
import { HybridVideoSvgAvatarRenderer } from "./avatar/AvatarRenderer";

const ECHO_TAIL_GUARD_MS = 300;

const SAMPLES = [
  { speaker: "クライアント", text: "スマホ表示のとき、画面下部に予約ボタンを固定したいです。" },
  { speaker: "クライアント", text: "トップページのメイン写真は来週金曜までに弊社から支給します。" },
  { speaker: "クライアント", text: "お問い合わせフォームで電話番号を必須にするかは社内で確認後に連絡します。" },
  { speaker: "制作担当", text: "初回公開日は来月20日で進めましょう。こちらは合意・決定ですね。" },
];

const avatar = new HybridVideoSvgAvatarRenderer();

let ollamaConnected = false;
let soundEnabled = true;
let echoGateActive = false;
let currentProjectId = "";
let currentMeetingId = "";
let currentSocket: WebSocket | null = null;
let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: BlobPart[] = [];
let voiceTalkRecorder: MediaRecorder | null = null;
let sampleIdx = 0;

function $<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing DOM element: #${id}`);
  return node as T;
}

function shouldUseMock(): boolean {
  const mode = $<HTMLSelectElement>("modeSelect").value;
  if (mode === "mock") return true;
  if (mode === "ollama") return false;
  return !ollamaConnected;
}

function setEchoGate(active: boolean): void {
  echoGateActive = active;
  const recordBtn = $<HTMLButtonElement>("recordBtn");
  const voiceTalkBtn = $<HTMLButtonElement>("voiceTalkBtn");
  const gateStatus = $<HTMLSpanElement>("echoGateStatus");
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
    recordBtn.disabled = false;
    voiceTalkBtn.disabled = false;
    gateStatus.textContent = "待機中（ボタンを押して発話を録音）";
  }
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
  for (const item of items) {
    const li = document.createElement("li");
    if (item.carried_over) {
      const badge = document.createElement("span");
      badge.className = "item-tag";
      badge.textContent = "前回引継";
      li.appendChild(badge);
    }
    if (item.is_locked) {
      const lockBadge = document.createElement("span");
      lockBadge.className = "item-tag";
      lockBadge.textContent = "🔒保護";
      li.appendChild(lockBadge);
    }
    li.appendChild(document.createTextNode(item.content));
    ul.appendChild(li);
  }
}

function renderBoard(board: BoardMap): void {
  renderBoardCard("listDecisions", board.decisions, "まだ決定事項はありません");
  renderBoardCard("listRequests", board.requests, "まだ要望はありません");
  renderBoardCard("listMaterials", board.waiting_materials, "まだ素材待ちはありません");
  renderBoardCard("listUndecided", board.undecided, "まだ未決定事項はありません");

  if (board.undecided.length > 0) {
    $<HTMLElement>("nextFocusText").textContent =
      `未決定事項 ${board.undecided.length} 件（${board.undecided[0].content}）`;
  }
}

function renderUtterances(utterances: Utterance[]): void {
  const ol = $<HTMLOListElement>("transcriptList");
  ol.replaceChildren();
  if (utterances.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-hint";
    li.textContent = "音声録音またはテキスト入力で発言を記録します";
    ol.appendChild(li);
    return;
  }
  for (const u of utterances) {
    const li = document.createElement("li");
    const srcTag = u.source === "stt" ? "🎤" : "⌨️";
    li.textContent = `${srcTag} [${u.speaker}] ${u.text}`;
    ol.appendChild(li);
  }
  ol.scrollTop = ol.scrollHeight;
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
      if (msg.event === "board.updated" && msg.data?.board) {
        renderBoard(msg.data.board);
      } else if (msg.event === "avatar.state" && msg.data?.state && !echoGateActive) {
        avatar.setState(msg.data.state);
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

  const ollamaBadge = $<HTMLSpanElement>("ollamaBadge");
  ollamaBadge.className = ollamaConnected ? "badge badge-ok" : "badge badge-warn";
  ollamaBadge.textContent = ollamaConnected ? "🟢 Ollama接続中" : "🟡 デモモード（Ollama未接続）";

  const vvBadge = $<HTMLSpanElement>("voicevoxBadge");
  vvBadge.className = h.voicevox.connected ? "badge badge-ok" : "badge badge-warn";
  vvBadge.textContent = h.voicevox.connected
    ? `🟢 VOICEVOX (${h.voicevox.version})`
    : "🟡 ブラウザ音声フォールバック";

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

async function loadMeetingsAndSelect(targetMeetingId?: string): Promise<void> {
  const { meetings } = await apiJson<{ meetings: MeetingSummaryInfo[] }>("/api/meetings");
  const sel = $<HTMLSelectElement>("meetingSelect");
  sel.replaceChildren();
  for (const m of meetings) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = `${m.title} (${m.status === "completed" ? "完了" : "進行中"})`;
    sel.appendChild(opt);
  }
  if (meetings.length > 0) {
    const chosen = targetMeetingId || meetings[0].id;
    sel.value = chosen;
    await selectMeeting(chosen);
  }
}

async function selectMeeting(meetingId: string): Promise<void> {
  currentMeetingId = meetingId;
  const detail = await apiJson<{
    meeting: MeetingSummaryInfo;
    utterances: Utterance[];
    board: BoardMap;
  }>(`/api/meetings/${meetingId}`);

  currentProjectId = detail.meeting.project_id;
  $<HTMLSpanElement>("projectLabel").textContent =
    `${detail.meeting.client_name || ""} ${detail.meeting.project_name || ""}`.trim() || "案件";
  $<HTMLHeadingElement>("meetingTitleHeading").textContent = detail.meeting.title;
  $<HTMLParagraphElement>("meetingAgendaText").textContent = detail.meeting.agenda;
  renderUtterances(detail.utterances);
  renderBoard(detail.board);
  connectMeetingSocket(meetingId);
}

async function toggleRecording(): Promise<void> {
  if (echoGateActive) return;
  const recordBtn = $<HTMLButtonElement>("recordBtn");
  const gateStatus = $<HTMLSpanElement>("echoGateStatus");

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
      recordBtn.textContent = "🎤 録音開始（Whisper文字起こし）";
      gateStatus.textContent = "Whisperでローカル文字起こし中...";
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
          board?: BoardMap;
        }>(`/api/meetings/${currentMeetingId}/audio`, { method: "POST", body: fd });

        if (!res.skipped) {
          await selectMeeting(currentMeetingId);
        }
        gateStatus.textContent = res.transcribed_text
          ? `認識結果: 「${res.transcribed_text}」`
          : "無音のためスキップしました";
      } catch (err) {
        alert((err as Error).message);
        gateStatus.textContent = "文字起こしエラー";
      } finally {
        avatar.setState("idle");
      }
    };

    mediaRecorder.start();
    avatar.setState("listening");
    recordBtn.classList.add("recording");
    recordBtn.textContent = "⏹ 録音停止して文字起こし送信";
    gateStatus.textContent = "🔴 録音中... 話し終えたら停止を押してください";
  } catch {
    alert("マイクへのアクセスが許可されていないか、利用できない環境です。");
  }
}

async function startOrStopVoiceConversation(): Promise<void> {
  if (echoGateActive || !currentMeetingId) return;

  const btn = $<HTMLButtonElement>("voiceTalkBtn");
  const hint = $<HTMLParagraphElement>("voiceTalkHint");
  const heardLine = $<HTMLParagraphElement>("userHeardText");

  // 録音中にもう一度押された場合は即時送信する
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
      btn.textContent = "🎙️ 声でAIに話しかける（話し終えると自動返答）";

      if (timedOutSilence || chunks.length === 0) {
        avatar.setState("idle");
        hint.textContent = "音声が検出されませんでした。ボタンを押して話しかけてください。";
        return;
      }

      avatar.setState("thinking");
      btn.disabled = true;
      hint.textContent = "🧠 Whisperで音声認識 ＆ AI返答を作成中（初回のみ数十秒かかります）...";

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

        btn.disabled = false;

        if (res.skipped || !res.transcribed_text) {
          avatar.setState("idle");
          hint.textContent = "無音のためスキップしました。もう一度話しかけてください。";
          return;
        }

        heardLine.hidden = false;
        heardLine.textContent = `あなた: 「${res.transcribed_text}」`;
        if (res.next_focus) {
          $<HTMLElement>("nextFocusText").textContent = res.next_focus;
        }

        // 声で「締めて／まとめて」と言われた場合は確定議事録モーダルも自動表示する
        if (res.is_summary) {
          $<HTMLInputElement>("continuousTalkCheck").checked = false;
          const ul = $<HTMLUListElement>("nextActionsList");
          ul.replaceChildren();
          for (const act of res.next_actions || []) {
            const li = document.createElement("li");
            li.textContent = act;
            ul.appendChild(li);
          }
          $<HTMLTextAreaElement>("markdownOutput").value = res.markdown_report || "";
          $<HTMLDialogElement>("reportDialog").showModal();
          await loadMeetingsAndSelect(currentMeetingId);
        } else {
          await selectMeeting(currentMeetingId);
        }

        hint.textContent = "🔊 AIファシリテーターが返答中...";

        await playFacilitatorVoice(res.spoken_message || "", res.audio_url || null, () => {
          hint.textContent = "ボタンを押して話しかけると、AIが声で返事します";
          if ($<HTMLInputElement>("continuousTalkCheck").checked) {
            startOrStopVoiceConversation();
          }
        });
      } catch (err) {
        btn.disabled = false;
        avatar.setState("idle");
        hint.textContent = "音声対話エラーが発生しました";
        alert((err as Error).message);
      }
    };

    rec.start();
    avatar.setState("listening");
    btn.classList.add("listening");
    btn.textContent = "⏹ 聞き取り中...（話し終えると自動送信 / クリックで即送信）";
    hint.textContent = "🎤 マイクに向かって話しかけてください（例：「こんにちは」「未決定事項を教えて」）";
  } catch {
    alert("マイクの使用をブラウザで「許可」してください。");
  }
}

async function enterAuthenticatedApp(): Promise<void> {
  $<HTMLElement>("authView").hidden = true;
  $<HTMLElement>("appView").hidden = false;
  await avatar.mount($<HTMLElement>("avatarMount"));
  await refreshHealth();
  await loadMeetingsAndSelect();
}

function bindEvents(): void {
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
      await enterAuthenticatedApp();
    } catch (err) {
      loginError.textContent = (err as Error).message;
      loginError.hidden = false;
      passInput.focus();
    } finally {
      loginSubmitBtn.disabled = false;
    }
  });

  $<HTMLButtonElement>("logoutBtn").addEventListener("click", async () => {
    await apiJson("/api/auth/logout", { method: "POST" });
    if (currentSocket) currentSocket.close();
    $<HTMLElement>("appView").hidden = true;
    $<HTMLElement>("authView").hidden = false;
  });

  $<HTMLSelectElement>("meetingSelect").addEventListener("change", (e) => {
    const id = (e.target as HTMLSelectElement).value;
    if (id) selectMeeting(id);
  });

  $<HTMLButtonElement>("soundToggleBtn").addEventListener("click", (e) => {
    soundEnabled = !soundEnabled;
    const btn = e.currentTarget as HTMLButtonElement;
    btn.setAttribute("aria-pressed", String(soundEnabled));
    btn.textContent = soundEnabled ? "🔊 音声 ON" : "🔇 音声 OFF";
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
    const input = $<HTMLTextAreaElement>("utteranceInput");
    const text = input.value.trim();
    if (!text || !currentMeetingId) return;

    const btn = $<HTMLButtonElement>("addUtteranceBtn");
    btn.disabled = true;
    avatar.setState("thinking");
    try {
      await apiJson(`/api/meetings/${currentMeetingId}/utterances`, {
        method: "POST",
        body: JSON.stringify({
          text,
          speaker: $<HTMLSelectElement>("speakerSelect").value,
          model: $<HTMLInputElement>("modelInput").value.trim(),
          use_mock: shouldUseMock(),
        }),
      });
      input.value = "";
      await selectMeeting(currentMeetingId);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      btn.disabled = false;
      avatar.setState("idle");
    }
  });

  const triggerFacilitate = async (question: string) => {
    if (!currentMeetingId) return;
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
      await playFacilitatorVoice(res.spoken_message, res.audio_url);
    } catch (err) {
      avatar.setState("idle");
      alert((err as Error).message);
    }
  };

  $<HTMLButtonElement>("timeCheckBtn").addEventListener("click", () => triggerFacilitate(""));

  $<HTMLFormElement>("askForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const askInput = $<HTMLInputElement>("askInput");
    const q = askInput.value.trim() || "ここまでの論点を整理してください";
    askInput.value = "";
    triggerFacilitate(q);
  });

  $<HTMLButtonElement>("summarizeBtn").addEventListener("click", async () => {
    if (!currentMeetingId) return;
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
      const ul = $<HTMLUListElement>("nextActionsList");
      ul.replaceChildren();
      for (const act of res.next_actions) {
        const li = document.createElement("li");
        li.textContent = act;
        ul.appendChild(li);
      }
      $<HTMLTextAreaElement>("markdownOutput").value = res.markdown_report;
      $<HTMLDialogElement>("reportDialog").showModal();
      await playFacilitatorVoice(res.spoken_closing, res.audio_url);
      await loadMeetingsAndSelect(currentMeetingId);
    } catch (err) {
      avatar.setState("idle");
      alert((err as Error).message);
    }
  });

  // 新規会議（課題引き継ぎ）モーダル
  const newMeetingDialog = $<HTMLDialogElement>("newMeetingDialog");
  $<HTMLButtonElement>("openNewMeetingBtn").addEventListener("click", () => newMeetingDialog.showModal());
  $<HTMLButtonElement>("cancelNewMeetingBtn").addEventListener("click", () => newMeetingDialog.close());
  $<HTMLFormElement>("newMeetingForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await apiJson<{ meeting: MeetingSummaryInfo }>("/api/meetings", {
      method: "POST",
      body: JSON.stringify({
        project_id: currentProjectId,
        title: $<HTMLInputElement>("newMeetingTitle").value.trim(),
        agenda: $<HTMLTextAreaElement>("newMeetingAgenda").value.trim(),
        carry_over: $<HTMLInputElement>("carryOverCheck").checked,
      }),
    });
    newMeetingDialog.close();
    await loadMeetingsAndSelect(res.meeting.id);
  });

  // ボード手動追加（ロック）モーダル
  const addBoardDialog = $<HTMLDialogElement>("addBoardDialog");
  $<HTMLButtonElement>("openAddBoardItemBtn").addEventListener("click", () => addBoardDialog.showModal());
  $<HTMLButtonElement>("cancelAddBoardBtn").addEventListener("click", () => addBoardDialog.close());
  $<HTMLFormElement>("addBoardForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const contentInput = $<HTMLInputElement>("manualContent");
    const res = await apiJson<{ board: BoardMap }>(`/api/meetings/${currentMeetingId}/board-items`, {
      method: "PATCH",
      body: JSON.stringify({
        category: $<HTMLSelectElement>("manualCategory").value,
        content: contentInput.value.trim(),
        is_locked: true,
      }),
    });
    contentInput.value = "";
    addBoardDialog.close();
    renderBoard(res.board);
  });

  $<HTMLButtonElement>("downloadMdBtn").addEventListener("click", () => {
    const md = $<HTMLTextAreaElement>("markdownOutput").value;
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `minutes-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  });

  $<HTMLButtonElement>("copyMdBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    await navigator.clipboard.writeText($<HTMLTextAreaElement>("markdownOutput").value);
    btn.textContent = "✅ コピー完了";
    window.setTimeout(() => {
      btn.textContent = "📋 コピー";
    }, 1500);
  });
}

async function boot(): Promise<void> {
  bindEvents();
  try {
    const me = await apiJson<{ authenticated: boolean }>("/api/auth/me");
    if (me.authenticated) {
      await enterAuthenticatedApp();
    }
  } catch {
    // show login screen
  }
}

boot();
