export type AvatarState = "idle" | "listening" | "thinking" | "speaking";

export interface AvatarRenderer {
  mount(container: HTMLElement): Promise<void>;
  setState(state: AvatarState, customLabel?: string): void;
  setUseCustomVideos(enabled: boolean): void;
  bindAudioSource?(audioContext: AudioContext, sourceNode: AudioNode): void;
  dispose(): void;
}

export const AVATAR_STATE_LABELS: Record<AvatarState, string> = {
  idle: "待機中（傾聴モード）",
  listening: "🎤 聞き取り中...",
  thinking: "🧠 論点を整理中...",
  speaking: "🔊 AIファシリテーター発話中",
};

/**
 * 全画面スピーカービュー対応アバターレンダラー（Phase 1）
 * - static/videos/ に idle.mp4 / talk.mp4 がある場合は全画面カバー動画で描画
 * - 未配置時は16:9大型モニターで見やすいバストアップSVGアバターを描画
 * - Phase 2 で Live2D / Three.js (VRM) へ差し替え可能な共通インターフェースを実装
 */
export class HybridVideoSvgAvatarRenderer implements AvatarRenderer {
  private container: HTMLElement | null = null;
  private videoIdle: HTMLVideoElement | null = null;
  private videoTalk: HTMLVideoElement | null = null;
  private svgWrap: HTMLDivElement | null = null;
  private onStateChange?: (label: string, state: AvatarState) => void;
  private useVideos = false;

  constructor(onStateChange?: (label: string, state: AvatarState) => void) {
    this.onStateChange = onStateChange;
  }

  async mount(container: HTMLElement): Promise<void> {
    this.container = container;
    container.replaceChildren();
    container.dataset.state = "idle";

    const vIdle = document.createElement("video");
    vIdle.className = "avatar-video";
    vIdle.width = 1920;
    vIdle.height = 1080;
    vIdle.muted = true;
    vIdle.loop = true;
    vIdle.playsInline = true;
    vIdle.hidden = true;
    vIdle.setAttribute("aria-hidden", "true");

    const vTalk = document.createElement("video");
    vTalk.className = "avatar-video";
    vTalk.width = 1920;
    vTalk.height = 1080;
    vTalk.muted = true;
    vTalk.loop = true;
    vTalk.playsInline = true;
    vTalk.hidden = true;
    vTalk.setAttribute("aria-hidden", "true");

    const svgWrap = document.createElement("div");
    svgWrap.className = "avatar-stage-figure";

    const aura = document.createElement("div");
    aura.className = "avatar-aura";

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 640 480");
    svg.setAttribute("width", "640");
    svg.setAttribute("height", "480");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("avatar-svg");

    const mk = <K extends keyof SVGElementTagNameMap>(
      tag: K,
      attrs: Record<string, string>,
    ): SVGElementTagNameMap[K] => {
      const el = document.createElementNS(svgNS, tag);
      for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
      }
      return el;
    };

    // 肩・ジャケット（16:9バストアップ構図）
    const jacket = mk("path", {
      d: "M130 480 C142 356, 224 318, 320 318 C416 318, 498 356, 510 480 Z",
      fill: "#1e3a8a",
    });
    const shirt = mk("polygon", {
      points: "282,320 358,320 338,430 302,430",
      fill: "#f8fafc",
    });
    const tie = mk("polygon", {
      points: "312,338 328,338 336,426 320,446 304,426",
      fill: "#38bdf8",
    });
    const neck = mk("rect", {
      x: "294",
      y: "272",
      width: "52",
      height: "60",
      rx: "20",
      fill: "#fbd38d",
    });

    // 頭部・髪・耳
    const earL = mk("circle", { cx: "208", cy: "198", r: "18", fill: "#fbd38d" });
    const earR = mk("circle", { cx: "432", cy: "198", r: "18", fill: "#fbd38d" });
    const head = mk("rect", {
      x: "212",
      y: "86",
      width: "216",
      height: "214",
      rx: "98",
      fill: "#fde68a",
    });
    const hair = mk("path", {
      d: "M206 178 C206 82, 434 82, 434 178 C408 128, 356 116, 316 118 C268 120, 228 138, 206 178 Z",
      fill: "#1e293b",
    });

    // 眉・目・頬・口
    const browL = mk("rect", { x: "254", y: "162", width: "36", height: "6", rx: "3", fill: "#334155" });
    const browR = mk("rect", { x: "350", y: "162", width: "36", height: "6", rx: "3", fill: "#334155" });

    const eyeL = mk("circle", { cx: "272", cy: "190", r: "10", fill: "#0f172a" });
    eyeL.classList.add("avatar-eye");
    const eyeR = mk("circle", { cx: "368", cy: "190", r: "10", fill: "#0f172a" });
    eyeR.classList.add("avatar-eye");

    const cheekL = mk("ellipse", { cx: "248", cy: "218", rx: "16", ry: "9", fill: "#fca5a5", opacity: "0.45" });
    const cheekR = mk("ellipse", { cx: "392", cy: "218", rx: "16", ry: "9", fill: "#fca5a5", opacity: "0.45" });

    const mouth = mk("rect", {
      x: "294",
      y: "242",
      width: "52",
      height: "11",
      rx: "6",
      fill: "#be123c",
    });
    mouth.classList.add("avatar-mouth");

    svg.append(
      jacket,
      shirt,
      tie,
      neck,
      earL,
      earR,
      head,
      hair,
      browL,
      browR,
      eyeL,
      eyeR,
      cheekL,
      cheekR,
      mouth,
    );
    svgWrap.append(aura, svg);

    container.append(vIdle, vTalk, svgWrap);
    this.videoIdle = vIdle;
    this.videoTalk = vTalk;
    this.svgWrap = svgWrap;
  }

  setUseCustomVideos(enabled: boolean): void {
    this.useVideos = enabled;
    if (!this.svgWrap || !this.videoIdle || !this.videoTalk) return;
    if (enabled) {
      if (!this.videoIdle.src) this.videoIdle.src = "/videos/idle.mp4";
      if (!this.videoTalk.src) this.videoTalk.src = "/videos/talk.mp4";
      this.svgWrap.hidden = true;
      this.videoIdle.hidden = false;
      this.videoIdle.play().catch(() => {});
    } else {
      this.svgWrap.hidden = false;
      this.videoIdle.hidden = true;
      this.videoTalk.hidden = true;
    }
  }

  setState(state: AvatarState, customLabel?: string): void {
    if (!this.container) return;
    this.container.dataset.state = state;
    const label = customLabel || AVATAR_STATE_LABELS[state];
    if (this.onStateChange) {
      this.onStateChange(label, state);
    }

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
