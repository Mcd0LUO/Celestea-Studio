// W750 · 内置模型图标（按模型 id 前缀自动识别）
//
// 纯函数、零 import、零 DOM：既能被浏览器打包，也能被服务端 vitest 跨仓直测
// （先例：src/security/scope-hash.ts ← /src/celestea_studio-ts/tests/*.test.ts）。
//
// 设计约束：
//   - 图标**只**做家族级识别（不认具体型号），未命中一律返回 null —— 不占位、
//     不留空框，列表行与状态栏都不会因缺图标而错位；
//   - SVG 一律 currentColor + 无内联颜色，颜色由 CSS 变量（--mi-<key>）决定，
//     深浅色主题各自可读；
//   - 形状/字母都是风格化几何（圆/圆角方/六边形/三角 + 家族首字母），不是任何
//     厂商标识，规避商标风险。
// ============================================================================

/** 已识别家族：deepseek / openai(gpt·o 系列) / glm / claude。 */
export type ModelIconKey = 'deepseek' | 'openai' | 'glm' | 'claude';

export interface ModelIcon {
  /** 家族键：CSS 用 .sl-micon-<key> 上色（--mi-<key>）。 */
  key: ModelIconKey;
  /** 内置 SVG 源码（viewBox 0 0 16 16，颜色一律 currentColor）。 */
  svg: string;
}

/** 家族外框（几何形状，非商标）：圆 / 圆角方 / 六边形 / 三角。 */
const FRAMES: Record<ModelIconKey, string> = {
  deepseek: '<circle cx="8" cy="8" r="6.7" />',
  openai: '<rect x="1.4" y="1.4" width="13.2" height="13.2" rx="4" />',
  glm: '<path d="M8 1.5 13.9 4.9v6.2L8 14.5 2.1 11.1V4.9Z" />',
  claude: '<path d="M8 1.8 14.3 13.6H1.7Z" />',
};

/** 家族首字母（几何化：等宽字重 + 居中对齐）。 */
const GLYPHS: Record<ModelIconKey, string> = {
  deepseek: 'D',
  openai: 'G',
  glm: 'L',
  claude: 'C',
};

const svgCache = new Map<ModelIconKey, string>();

function svgFor(key: ModelIconKey): string {
  const hit = svgCache.get(key);
  if (hit !== undefined) return hit;
  const svg =
    '<svg class="sl-micon-svg" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">' +
    '<g fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round">' +
    FRAMES[key] +
    '</g>' +
    '<text x="8" y="11.3" text-anchor="middle" font-size="8.5" font-weight="700" ' +
    'font-family="ui-monospace, SFMono-Regular, Menlo, monospace" fill="currentColor">' +
    GLYPHS[key] +
    '</text>' +
    '</svg>';
  svgCache.set(key, svg);
  return svg;
}

/**
 * 模型 id → 家族键；未命中返回 null。
 *
 * 大小写不敏感、分隔符不敏感（`- _ . / :` 与空白都当分隔符），并且**任一**片段
 * 命中即可 —— 因此 `deepseek-chat`、`DeepSeek-V3`、`deepseek_v3`、
 * `celestea/deepseek-r1` 同样命中。
 */
export function modelIconKeyFor(modelId: string): ModelIconKey | null {
  const raw = typeof modelId === 'string' ? modelId.trim().toLowerCase() : '';
  if (raw === '') return null;
  const tokens = raw.split(/[^a-z0-9]+/).filter((t) => t !== '');
  const any = (pred: (t: string) => boolean): boolean => tokens.some(pred);
  if (any((t) => t.startsWith('deepseek'))) return 'deepseek';
  if (any((t) => t.startsWith('glm') || t.startsWith('chatglm'))) return 'glm';
  // gpt / chatgpt / o1·o2·o3·o4 系列（o4-mini、o3-deep-research、o1mini 都算）。
  if (any((t) => t.startsWith('gpt') || t === 'chatgpt' || /^o[1-4][a-z0-9]*$/.test(t))) return 'openai';
  if (any((t) => t.startsWith('claude') || t === 'anthropic' || t === 'sonnet' || t === 'opus' || t === 'haiku')) {
    return 'claude';
  }
  return null;
}

/** 模型 id → 内置图标（`{ key, svg }`）；未命中返回 null（调用方不占位）。 */
export function modelIconFor(modelId: string): ModelIcon | null {
  const key = modelIconKeyFor(modelId);
  return key === null ? null : { key, svg: svgFor(key) };
}
