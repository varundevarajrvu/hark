/**
 * What Vector says out loud. A reply on screen is markdown with code, links, tables and cards; spoken, it is
 * plain sentences: no markup, no raw URLs (the host is enough), no code or tables (they are "on screen"),
 * capped at a sentence boundary. Tool traces, browser steps and raw data are never spoken.
 */
import type { ChatMessage, HandoffRun, Id } from '../../../shared/types.ts';
import { urlParts } from './url.ts';

export const SPOKEN_CAP = 700;
export const REST_ON_SCREEN = 'The rest is on screen.';
export const APPROVAL_LINE = 'This needs your approval on screen.';
export const RUN_FAILED_LINE = 'That did not work. The details are on screen.';
const LIST_LIMIT = 4;

const hostOf = (url: string): string => urlParts(url).host.replace(/^www\./, '') || 'a link';

/** Close a fragment as a sentence so the voice pauses between blocks. */
function sentence(text: string): string {
  const t = text.trim();
  if (!t) return '';
  return /[.!?…:]["'”’)]*$/.test(t) ? t : `${t}.`;
}

function inline(text: string): string {
  return (
    text
      // images and links: keep what the link says, or the host for a bare one
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, label: string, url: string) => (/^https?:/i.test(label.trim()) ? hostOf(url) : label))
      .replace(/<(https?:[^>\s]+)>/gi, (_, url: string) => hostOf(url))
      .replace(/\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/gi, (url) => hostOf(url))
      // inline code: short reads fine, long is not worth hearing
      .replace(/`([^`]*)`/g, (_, code: string) => (code.length <= 24 && !/[{}();=<>]/.test(code) ? code : 'code on screen'))
      // emphasis, strike, html
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Markdown → plain spoken sentences. */
export function speakableMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  const said = (text: string) => {
    if (text && out[out.length - 1] !== text) out.push(text);
  };
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      const fence = trimmed.slice(0, 3);
      i++;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(fence)) i++;
      i++;
      said('Code on screen.');
      continue;
    }
    if (/^\|/.test(trimmed)) {
      while (i < lines.length && /^\|/.test((lines[i] ?? '').trim())) i++;
      said('Details on screen.');
      continue;
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
    if (item.test(line)) {
      const items: string[] = [];
      while (i < lines.length && (item.test(lines[i] ?? '') || /^\s{2,}\S/.test(lines[i] ?? ''))) {
        const m = (lines[i] ?? '').match(item);
        if (m) items.push(inline((m[1] ?? '').replace(/^\[[ xX]\]\s*/, '')));
        i++;
      }
      if (items.length > LIST_LIMIT) said('Details on screen.');
      else for (const it of items) said(sentence(it));
      continue;
    }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line) || !trimmed) {
      i++;
      continue;
    }
    said(sentence(inline(trimmed.replace(/^#{1,6}\s+/, '').replace(/^>\s?/, ''))));
    i++;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** Keep the first `cap` characters, cut back to the last full sentence, and say that there is more. */
export function capSpoken(text: string, cap = SPOKEN_CAP): string {
  if (text.length <= cap) return text;
  const head = text.slice(0, cap);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '), head.lastIndexOf('… '));
  const cut = end > cap * 0.4 ? head.slice(0, end + 1) : head.slice(0, head.lastIndexOf(' ')).replace(/[,;:]$/, '') + '…';
  return `${cut.trim()} ${REST_ON_SCREEN}`;
}

/** The whole reply as speech: text parts, a browser run's short result, one line per notice or approval. */
export function speakableReply(message: ChatMessage, handoffs: Record<Id, HandoffRun>): string {
  const pieces: string[] = [];
  for (const part of message.parts) {
    if (part.type === 'text') pieces.push(speakableMarkdown(part.text));
    else if (part.type === 'handoff') {
      const run = handoffs[part.runId];
      const first = run?.result ? (run.result.split(/(?<=[.!?])\s/)[0] ?? run.result) : '';
      if (first) pieces.push(sentence(inline(first)));
    } else if (part.type === 'notice') pieces.push(part.tone === 'error' ? 'Something went wrong; it is on screen.' : 'There is a note on screen.');
    else if (part.type === 'approval') pieces.push(APPROVAL_LINE);
    // tool traces: never
  }
  const seen = new Set<string>();
  const text = pieces
    .filter((p) => p && !seen.has(p) && seen.add(p))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return capSpoken(text);
}
