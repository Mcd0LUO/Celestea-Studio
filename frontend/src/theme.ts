// ============================================================================
// Theme / color-card switching: <html data-theme> single attribute.
// palettes: night (夜航黑灰, default) / sakura (樱花粉亮) / klein (克莱因蓝亮)
// ============================================================================

export interface ThemeDef {
  id: string;
  label: string;
  hint: string;
}

export const THEMES: readonly ThemeDef[] = [
  { id: 'night', label: '夜航', hint: '夜航黑灰 · 近中性暗色' },
  { id: 'sakura', label: '樱花', hint: '樱花粉 · 亮色' },
  { id: 'klein', label: '克莱因', hint: '克莱因蓝 · 亮色' },
];

const STORAGE_KEY = 'celestea-studio.theme';

export function currentTheme(): string {
  return document.documentElement.dataset.theme || 'night';
}

export function applyTheme(id: string): void {
  document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* storage unavailable — ignore */
  }
}

/** Apply the persisted (or default) theme; returns the applied id. */
export function initTheme(defaultId = 'night'): string {
  let id = defaultId;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && THEMES.some((t) => t.id === saved)) id = saved;
  } catch {
    /* ignore */
  }
  applyTheme(id);
  return id;
}

/** Wire the topbar switcher: cycles night → sakura → klein.
 *  Also exposes a programmatic switch for future pickers. */
export function setupThemeSwitcher(button: HTMLElement): void {
  const themeDef = (): ThemeDef => {
    const cur = currentTheme();
    return THEMES.find((t) => t.id === cur) ?? THEMES[0]!;
  };
  const render = () => {
    const t = themeDef();
    button.textContent = t.label;
    button.title = '主题 · ' + t.hint + '（点击切换）';
  };
  render();
  button.addEventListener('click', () => {
    const idx = THEMES.findIndex((t) => t.id === currentTheme());
    const next = THEMES[(idx + 1) % THEMES.length]!;
    applyTheme(next.id);
    render();
  });
}
