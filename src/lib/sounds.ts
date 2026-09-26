export type SoundCue = "startup" | "connect" | "disconnect";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface Tone {
  at: number;
  duration: number;
  frequency: number;
  endFrequency: number;
  gain: number;
  type: OscillatorType;
}

export const SOUND_PREFERENCE_KEY = "directtalk.sounds";

const SOUND_PATTERNS: Record<SoundCue, readonly Tone[]> = {
  startup: [
    { at: 0, duration: 0.22, frequency: 392, endFrequency: 523.25, gain: 0.018, type: "triangle" },
    { at: 0.12, duration: 0.24, frequency: 523.25, endFrequency: 659.25, gain: 0.021, type: "sine" },
    { at: 0.27, duration: 0.31, frequency: 659.25, endFrequency: 987.77, gain: 0.017, type: "sine" },
  ],
  connect: [
    { at: 0, duration: 0.18, frequency: 587.33, endFrequency: 739.99, gain: 0.024, type: "sine" },
    { at: 0.1, duration: 0.24, frequency: 739.99, endFrequency: 987.77, gain: 0.021, type: "triangle" },
    { at: 0.23, duration: 0.22, frequency: 1174.66, endFrequency: 1318.51, gain: 0.014, type: "sine" },
  ],
  disconnect: [
    { at: 0, duration: 0.2, frequency: 659.25, endFrequency: 493.88, gain: 0.021, type: "triangle" },
    { at: 0.13, duration: 0.3, frequency: 493.88, endFrequency: 293.66, gain: 0.024, type: "sine" },
  ],
};

type AudioContextConstructor = new () => AudioContext;

class AppSoundPlayer {
  private enabled = true;
  private context: AudioContext | null = null;
  private startupPlayed = false;
  private lastPlayed = new Map<SoundCue, number>();

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  async play(cue: SoundCue): Promise<boolean> {
    if (!this.enabled) return false;
    if (cue === "startup" && this.startupPlayed) return true;
    if (typeof window === "undefined" || (document.visibilityState && document.visibilityState !== "visible")) return false;

    const Constructor = audioContextConstructor();
    if (!Constructor) return false;

    try {
      if (!this.context || this.context.state === "closed") this.context = new Constructor();
      const context = this.context;
      if (context.state === "suspended") await context.resume();
      if (!this.enabled || context.state !== "running") return false;
      if (cue === "startup" && this.startupPlayed) return true;

      const now = performance.now();
      const previous = this.lastPlayed.get(cue) ?? Number.NEGATIVE_INFINITY;
      if (now - previous < 250) return false;
      schedulePattern(context, SOUND_PATTERNS[cue]);
      this.lastPlayed.set(cue, now);
      if (cue === "startup") this.startupPlayed = true;
      return true;
    } catch {
      return false;
    }
  }
}

function audioContextConstructor(): AudioContextConstructor | undefined {
  const audioWindow = window as typeof window & { webkitAudioContext?: AudioContextConstructor };
  return window.AudioContext ?? audioWindow.webkitAudioContext;
}

function schedulePattern(context: AudioContext, pattern: readonly Tone[]) {
  const start = context.currentTime + 0.012;
  for (const tone of pattern) {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const toneStart = start + tone.at;
    const toneEnd = toneStart + tone.duration;
    const attackEnd = Math.min(toneStart + 0.018, toneEnd);

    oscillator.type = tone.type;
    oscillator.frequency.setValueAtTime(tone.frequency, toneStart);
    oscillator.frequency.exponentialRampToValueAtTime(tone.endFrequency, toneEnd);
    envelope.gain.setValueAtTime(0.0001, toneStart);
    envelope.gain.exponentialRampToValueAtTime(tone.gain, attackEnd);
    envelope.gain.exponentialRampToValueAtTime(0.0001, toneEnd);
    oscillator.connect(envelope);
    envelope.connect(context.destination);
    oscillator.addEventListener("ended", () => {
      oscillator.disconnect();
      envelope.disconnect();
    }, { once: true });
    oscillator.start(toneStart);
    oscillator.stop(toneEnd + 0.01);
  }
}

export function readSoundEnabled(storage: StorageLike | undefined = browserStorage()): boolean {
  try {
    return storage?.getItem(SOUND_PREFERENCE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeSoundEnabled(enabled: boolean, storage: StorageLike | undefined = browserStorage()) {
  try {
    storage?.setItem(SOUND_PREFERENCE_KEY, enabled ? "on" : "off");
  } catch {
    // The preference is optional; sound still works for the current tab.
  }
}

function browserStorage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function soundPattern(cue: SoundCue): readonly Tone[] {
  return SOUND_PATTERNS[cue];
}

export const appSounds = new AppSoundPlayer();
