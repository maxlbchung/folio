export type ThemePreference = "system" | "light" | "dark";
export type UiScale = 0.8 | 0.9 | 1 | 1.1 | 1.2;
export type CardSize = "small" | "medium" | "large";

export interface AppPreferences {
  theme: ThemePreference;
  uiScale: UiScale;
  cardSize: CardSize;
  autosave: boolean;
}

const PREFERENCES_KEY = "inktile-preferences";
const UI_SCALES = new Set<UiScale>([0.8, 0.9, 1, 1.1, 1.2]);
const THEMES = new Set<ThemePreference>(["system", "light", "dark"]);
const CARD_SIZES = new Set<CardSize>(["small", "medium", "large"]);

export const DEFAULT_PREFERENCES: AppPreferences = {
  theme: "system",
  uiScale: 1,
  cardSize: "medium",
  autosave: true
};

export function readPreferences(): AppPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "null") as Partial<AppPreferences> | null;
    return {
      theme: stored?.theme && THEMES.has(stored.theme) ? stored.theme : DEFAULT_PREFERENCES.theme,
      uiScale: stored?.uiScale && UI_SCALES.has(stored.uiScale) ? stored.uiScale : DEFAULT_PREFERENCES.uiScale,
      cardSize: stored?.cardSize && CARD_SIZES.has(stored.cardSize) ? stored.cardSize : DEFAULT_PREFERENCES.cardSize,
      autosave: typeof stored?.autosave === "boolean" ? stored.autosave : DEFAULT_PREFERENCES.autosave
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function writePreferences(preferences: AppPreferences): void {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences remain active for this session when storage is unavailable.
  }
}
