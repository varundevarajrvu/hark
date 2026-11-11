import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * Assistant text is untrusted: it can quote web pages and e-mails. It is parsed as Markdown and the
 * resulting HTML is sanitised before it is ever inserted. Links can only be http(s)/mailto and always
 * open in a new tab without a referrer or an opener. Images, forms and embedded content are dropped.
 */
const purify = DOMPurify(window);

purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    if (node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    } else {
      node.removeAttribute('target');
    }
  }
});

const SANITIZE = {
  ALLOWED_TAGS: [
    'a', 'b', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'input',
    'li', 'ol', 'p', 'pre', 's', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
  ],
  ALLOWED_ATTR: ['href', 'title', 'align', 'start', 'type', 'checked', 'disabled', 'class'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

purify.addHook('uponSanitizeElement', (node, data) => {
  // The only <input> Markdown produces is a task-list checkbox: keep those, inert, and nothing else.
  if (data.tagName === 'input') {
    const el = node as Element;
    if (el.getAttribute('type') !== 'checkbox') el.remove();
    else el.setAttribute('disabled', '');
  }
});

purify.addHook('uponSanitizeAttribute', (_node, data) => {
  // `class` is only needed for code-block language hints.
  if (data.attrName === 'class' && !/^language-[\w-]+$/.test(data.attrValue)) data.keepAttr = false;
});

export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false, gfm: true, breaks: true });
  return purify.sanitize(html, SANITIZE);
}
