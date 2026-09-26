import { describe, expect, it } from "vitest";
import {
  readSoundEnabled,
  SOUND_PREFERENCE_KEY,
  soundPattern,
  writeSoundEnabled,
  type SoundCue,
} from "./sounds";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(SOUND_PREFERENCE_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("sound preferences", () => {
  it("enables sounds by default and restores an explicit mute", () => {
    expect(readSoundEnabled(memoryStorage())).toBe(true);
    expect(readSoundEnabled(memoryStorage("off"))).toBe(false);
    expect(readSoundEnabled(memoryStorage("on"))).toBe(true);
  });

  it("persists both preference values", () => {
    const storage = memoryStorage();
    writeSoundEnabled(false, storage);
    expect(readSoundEnabled(storage)).toBe(false);
    writeSoundEnabled(true, storage);
    expect(readSoundEnabled(storage)).toBe(true);
  });

  it("falls back safely when storage is blocked", () => {
    const blocked = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(readSoundEnabled(blocked)).toBe(true);
    expect(() => writeSoundEnabled(false, blocked)).not.toThrow();
  });
});

describe("procedural sound cues", () => {
  const cues: SoundCue[] = ["startup", "connect", "disconnect"];

  it("opens with a gentle three-note A-E-A motif", () => {
    const startup = soundPattern("startup");
    expect(startup).toHaveLength(3);
    expect(startup.map((tone) => tone.frequency)).toEqual([440, 659.25, 880]);
    expect(startup.every((tone) => tone.endFrequency > tone.frequency)).toBe(true);
  });

  it("uses short, quiet and distinct tone sequences", () => {
    const signatures = cues.map((cue) => {
      const pattern = soundPattern(cue);
      expect(pattern.length).toBeGreaterThanOrEqual(2);
      for (const tone of pattern) {
        expect(tone.at + tone.duration).toBeLessThan(0.65);
        expect(tone.gain).toBeGreaterThan(0);
        expect(tone.gain).toBeLessThanOrEqual(0.025);
        expect(tone.frequency).toBeGreaterThan(200);
        expect(tone.endFrequency).toBeGreaterThan(200);
      }
      return JSON.stringify(pattern);
    });
    expect(new Set(signatures).size).toBe(cues.length);
  });
});
