import { describe, expect, it } from "vitest";
import { localizeRuntimeMessage, resolveLanguage, translate } from "./i18n";

describe("language selection", () => {
  it("uses an explicit language instead of browser preferences", () => {
    expect(resolveLanguage("uk", ["pl-PL", "en-US"])).toBe("uk");
  });

  it("checks navigator languages in their declared order", () => {
    expect(resolveLanguage("auto", ["fr-FR", "pl-PL", "en-US"])).toBe("pl");
    expect(resolveLanguage("auto", ["uk-UA", "ru-RU"])).toBe("uk");
  });

  it("falls back to English for unsupported browser languages", () => {
    expect(resolveLanguage("auto", ["de-DE", "fr-FR"])).toBe("en");
    expect(resolveLanguage("auto", [])).toBe("en");
  });
});

describe("translations", () => {
  it("interpolates values", () => {
    expect(translate("pl", "message.placeholder", { name: "Ola" })).toBe("Wiadomość do Ola…");
    expect(translate("uk", "photo.received", { percent: 75 })).toBe("Отримано 75%");
  });

  it("localizes low-level Russian connection errors", () => {
    expect(localizeRuntimeMessage("en", "Не удалось подключиться к signaling-серверу")).toBe(
      "Could not connect to the signaling service.",
    );
    expect(localizeRuntimeMessage("pl", "Подпись ключа устройства недействительна")).toBe(
      "Nie udało się zweryfikować danych bezpiecznej sesji.",
    );
  });
});
