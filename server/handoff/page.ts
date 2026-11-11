/**
 * Code that runs inside the page. It is kept as source text and evaluated as an expression, because
 * functions compiled by the TypeScript runner can reference helpers that do not exist in the page.
 * Everything here reads the main frame only; content inside iframes is not visible to the agent.
 */

export const REF_ATTR = 'data-vector-ref';
/** Marks an element whose value came from the vault: never reported, masked in screenshots. */
export const SECRET_ATTR = 'data-vector-secret';

export interface SnapshotElement {
  ref: number;
  role: string;
  name: string;
  type?: string;
  placeholder?: string;
  href?: string;
  value?: string;
  checked?: boolean;
  options?: string[];
  disabled?: boolean;
}
export interface SnapshotResult {
  next: number;
  title: string;
  text: string;
  elements: SnapshotElement[];
  more: number;
}

/** What the consent guard needs to know about an element (or the focused element when ref is null). */
export interface ElementInfo {
  tag: string;
  inputType: string;
  /** Text of the element, or of the button/link it sits inside. */
  label: string;
  buttonLike: boolean;
  textEntry: boolean;
  multiline: boolean;
  select: boolean;
  inForm: boolean;
  /** The form is a plain search box: submitting it commits nothing. */
  formExempt: boolean;
}

const HELPERS = String.raw`
  const REF = ${JSON.stringify(REF_ATTR)}, SECRET = ${JSON.stringify(SECRET_ATTR)};
  const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clean(aria, 100);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.innerText : ''; }).join(' ');
      if (t.trim()) return clean(t, 100);
    }
    const tag = el.tagName;
    if (tag === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) return clean(el.value || el.type, 100);
    if (tag === 'INPUT' && el.type === 'image') return clean(el.alt || el.title || 'image button', 100);
    if (el.labels && el.labels.length) return clean(el.labels[0].innerText, 100);
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      const t = clean(el.innerText, 100);
      if (t) return t;
      const img = el.querySelector('img[alt]');
      if (img && img.alt) return clean(img.alt, 100);
    }
    return clean(el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '', 100);
  };
`;

export const SNAPSHOT_JS = String.raw`((arg) => {
  ${HELPERS}
  const SELECTOR = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=combobox], [role=textbox], [role=searchbox], [contenteditable=""], [contenteditable=true], [onclick]';
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  let next = arg.next, more = 0;
  const elements = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (!visible(el)) continue;
    if (elements.length >= arg.max) { more++; continue; }
    let ref = el.getAttribute(REF);
    if (!/^\d+$/.test(ref || '')) { ref = String(next++); el.setAttribute(REF, ref); }
    const tag = el.tagName.toLowerCase();
    const item = { ref: Number(ref), role: el.getAttribute('role') || tag, name: nameOf(el) };
    if (tag === 'input') item.type = el.type;
    const ph = el.getAttribute('placeholder');
    if (ph) item.placeholder = clean(ph, 60);
    if (tag === 'a') item.href = clean(el.getAttribute('href'), 120);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.hasAttribute(SECRET) || el.type === 'password') { if (el.value) item.value = '(hidden)'; }
      else if (el.type === 'checkbox' || el.type === 'radio') item.checked = !!el.checked;
      else if (tag === 'select') {
        item.value = clean(el.selectedOptions[0] ? el.selectedOptions[0].text : '', 60);
        item.options = Array.from(el.options).slice(0, 25).map((o) => clean(o.text, 40));
      } else if (el.value) item.value = clean(el.value, 80);
    }
    elements.push(item);
  }
  const text = (document.body ? document.body.innerText : '').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return { next, title: clean(document.title, 200), text: text.slice(0, arg.maxText), elements, more };
})`;

export const ELEMENT_INFO_JS = String.raw`((ref) => {
  ${HELPERS}
  const el = ref == null ? document.activeElement : document.querySelector('[' + REF + '="' + ref + '"]');
  if (!el || el === document.body || el === document.documentElement) return null;
  const tag = el.tagName.toLowerCase();
  const type = (el.type || '').toLowerCase();
  const host = el.closest('button, a[href], [role=button], [role=link], [role=menuitem], input[type=submit], input[type=button], input[type=image], summary') || el;
  const form = el.form || el.closest('form');
  let formExempt = false;
  if (form) {
    const fields = Array.from(form.elements).filter((e) => (e.tagName === 'INPUT' && !['hidden', 'submit', 'button', 'reset', 'image'].includes(e.type)) || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT');
    const sensitive = (e) => ['password', 'email', 'tel'].includes(e.type) || /cc-|card|cvc|cvv|e-?mail|phone|\btel\b|address|password/i.test([e.name, e.id, e.autocomplete, e.getAttribute('placeholder') || ''].join(' '));
    const searchy = (e) => e.type === 'search' || e.getAttribute('role') === 'searchbox';
    const searchForm = form.getAttribute('role') === 'search' || !!form.closest('[role=search]');
    const anySensitive = fields.some(sensitive);
    const single = fields.length === 1 && fields[0].tagName === 'INPUT' && ['text', 'search', 'url'].includes(fields[0].type);
    formExempt = !anySensitive && fields.length > 0 && (fields.every(searchy) || (searchForm && fields.every((e) => e.tagName === 'INPUT')) || single);
  }
  return {
    tag, inputType: type, label: nameOf(host),
    buttonLike: host !== el || ['button', 'a', 'summary'].includes(tag) || (tag === 'input' && ['submit', 'button', 'image'].includes(type)) || ['button', 'link', 'menuitem'].includes(el.getAttribute('role') || ''),
    textEntry: (tag === 'input' && !['checkbox', 'radio', 'submit', 'button', 'image', 'reset', 'file', 'range', 'color'].includes(type)) || tag === 'textarea' || el.isContentEditable,
    multiline: tag === 'textarea' || (el.isContentEditable && tag !== 'input'),
    select: tag === 'select',
    inForm: !!form, formExempt,
  };
})`;

export const markSecretJs = (ref: number) => `(() => { const el = document.querySelector('[${REF_ATTR}="${ref}"]'); if (el) el.setAttribute('${SECRET_ATTR}', '1'); })()`;

export function formatSnapshot(url: string, snap: SnapshotResult): string {
  const lines = [`URL: ${url}`, `Title: ${snap.title}`, '', 'Interactive elements:'];
  if (snap.elements.length === 0) lines.push('(none visible)');
  for (const e of snap.elements) {
    const bits = [`[${e.ref}]`, e.type && e.type !== e.role ? `${e.role}(${e.type})` : e.role, JSON.stringify(e.name)];
    if (e.placeholder && e.placeholder !== e.name) bits.push(`placeholder=${JSON.stringify(e.placeholder)}`);
    if (e.href) bits.push(`href=${JSON.stringify(e.href)}`);
    if (e.value !== undefined) bits.push(`value=${JSON.stringify(e.value)}`);
    if (e.checked !== undefined) bits.push(e.checked ? 'checked' : 'unchecked');
    if (e.options) bits.push(`options=${JSON.stringify(e.options)}`);
    if (e.disabled) bits.push('disabled');
    lines.push(bits.join(' '));
  }
  if (snap.more > 0) lines.push(`(${snap.more} more elements not listed)`);
  lines.push('', 'Visible text:', snap.text || '(no text)');
  return lines.join('\n');
}
