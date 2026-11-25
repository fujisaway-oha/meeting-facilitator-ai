export type AvatarState = "idle" | "listening" | "thinking" | "speaking";

export interface AvatarRenderer {
  mount(container: HTMLElement): Promise<void>;
  setState(state: AvatarState, customLabel?: string): void;
  setUseCustomVideos(enabled: boolean): void;
  bindAudioSource?(audioContext: AudioContext, sourceNode: AudioNode): void;
  dispose(): void;
}

const STATE_LABELS: Record<AvatarState, string> = {
  idle: "待機中（傾聴モード）",
  listening: "🎤 音声録音中...",
  thinking: "AIが論点を整理中...",
  speaking: "🔊 AIファシリテーター発話中",
};

/**
 * Phase 1 実装：MP4ループ動画（idle.mp4 / talk.mp4）配置時は実写・CG動画切替で描画し、
 * 未配置時は内蔵SVG口パクアニメーションで描画する。
 * Phase 2 で Live2D / Three.js (VRM) へ移行する際は同インターフェースの別クラスへ差し替える。
 */
export class HybridVideoSvgAvatarRenderer implements AvatarRenderer {
  private container: HTMLElement | null = null;
  private videoIdle: HTMLVideoElement | null = null;
  private videoTalk: HTMLVideoElement | null = null;
  private svgRoot: SVGSVGElement | null = null;
  private stateChip: HTMLSpanElement | null = null;
  private useVideos = false;

  async mount(container: HTMLElement): Promise<void> {
    this.container = container;
    container.replaceChildren();
    container.dataset.state = "idle";

    const vIdle = document.createElement("video");
    vIdle.className = "avatar-video";
    vIdle.width = 640;
    vIdle.height = 360;
    vIdle.muted = true;
    vIdle.loop = true;
    vIdle.playsInline = true;
    vIdle.hidden = true;
    vIdle.setAttribute("aria-hidden", "true");

    const vTalk = document.createElement("video");
    vTalk.className = "avatar-video";
    vTalk.width = 640;
    vTalk.height = 360;
    vTalk.muted = true;
    vTalk.loop = true;
    vTalk.playsInline = true;
    vTalk.hidden = true;
    vTalk.setAttribute("aria-hidden", "true");

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 240 180");
    svg.setAttribute("width", "240");
    svg.setAttribute("height", "180");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("avatar-svg");

    const head = document.createElementNS(svgNS, "circle");
    head.setAttribute("cx", "120");
    head.setAttribute("cy", "82");
    head.setAttribute("r", "52");
    head.setAttribute("fill", "#fde68a");

    const hair = document.createElementNS(svgNS, "path");
    hair.setAttribute("d", "M68 76 C70 34, 170 34, 172 76 C156 58, 84 58, 68 76 Z");
    hair.setAttribute("fill", "#334155");

    const eyeL = document.createElementNS(svgNS, "circle");
    eyeL.setAttribute("cx", "100");
    eyeL.setAttribute("cy", "80");
    eyeL.setAttribute("r", "5.5");
    eyeL.setAttribute("fill", "#1e293b");
    eyeL.classList.add("avatar-eye");

    const eyeR = document.createElementNS(svgNS, "circle");
    eyeR.setAttribute("cx", "140");
    eyeR.setAttribute("cy", "80");
    eyeR.setAttribute("r", "5.5");
    eyeR.setAttribute("fill", "#1e293b");
    eyeR.classList.add("avatar-eye");

    const mouth = document.createElementNS(svgNS, "rect");
    mouth.setAttribute("x", "106");
    mouth.setAttribute("y", "102");
    mouth.setAttribute("width", "28");
    mouth.setAttribute("height", "6");
    mouth.setAttribute("rx", "3");
    mouth.setAttribute("fill", "#be123c");
    mouth.classList.add("avatar-mouth");

    const body = document.createElementNS(svgNS, "path");
    body.setAttribute("d", "M64 176 C68 138, 172 138, 176 176 Z");
    body.setAttribute("fill", "#2563eb");

    svg.append(head, hair, eyeL, eyeR, mouth, body);

    const overlay = document.createElement("div");
    overlay.className = "stage-overlay";
    const roleChip = document.createElement("span");
    roleChip.className = "role-chip";
    roleChip.textContent = "AI進行・書記";
    const stateChip = document.createElement("span");
    stateChip.className = "state-chip";
    stateChip.textContent = STATE_LABELS.idle;
    overlay.append(roleChip, stateChip);

    container.append(vIdle, vTalk, svg, overlay);
    this.videoIdle = vIdle;
    this.videoTalk = vTalk;
    this.svgRoot = svg;
    this.stateChip = stateChip;
  }

  setUseCustomVideos(enabled: boolean): void {
    this.useVideos = enabled;
    if (!this.svgRoot || !this.videoIdle || !this.videoTalk) return;
    if (enabled) {
      if (!this.videoIdle.src) this.videoIdle.src = "/videos/idle.mp4";
      if (!this.videoTalk.src) this.videoTalk.src = "/videos/talk.mp4";
      this.svgRoot.style.display = "none";
      this.videoIdle.hidden = false;
      this.videoIdle.play().catch(() => {});
    } else {
      this.svgRoot.style.display = "";
      this.videoIdle.hidden = true;
      this.videoTalk.hidden = true;
    }
  }

  setState(state: AvatarState, customLabel?: string): void {
    if (!this.container || !this.stateChip) return;
    this.container.dataset.state = state;
    this.stateChip.textContent = customLabel || STATE_LABELS[state];

    if (!this.useVideos || !this.videoIdle || !this.videoTalk) return;

    if (state === "speaking") {
      this.videoIdle.hidden = true;
      this.videoTalk.hidden = false;
      this.videoTalk.play().catch(() => {});
    } else {
      this.videoTalk.hidden = true;
      this.videoIdle.hidden = false;
      this.videoIdle.play().catch(() => {});
    }
  }

  dispose(): void {
    if (this.container) {
      this.container.replaceChildren();
    }
  }
}
