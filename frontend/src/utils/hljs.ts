// ============================================================================
// Code highlighting — highlight.js core + a lean registered language set
// (token colors come from theme CSS via .hljs-* classes)
// ============================================================================
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

/** Highlight every not-yet-processed <pre><code> inside a container. */
export function highlightCode(container: Element): void {
  const blocks = Array.from(container.querySelectorAll<HTMLElement>('pre code'));
  for (const block of blocks) {
    if (block.dataset.hlDone === '1') continue;
    if (block.className.indexOf('language-') === -1) block.className += ' language-plaintext';
    try {
      hljs.highlightElement(block);
      block.dataset.hlDone = '1';
    } catch {
      /* unknown language → plain text */
    }
  }
}
