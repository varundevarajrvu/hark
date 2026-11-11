import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { masterKey } from './config.ts';
import { audit, users, vaultRows } from './db.ts';
import type { Id, VaultCreateBody, VaultItem } from '../../shared/types.ts';

/**
 * The vault. Design rules, enforced here and by the callers:
 *  1. Secrets are stored only as AES-256-GCM ciphertext under a per-user key derived (HKDF-SHA256)
 *     from the server master key and a per-user salt. The item id and user id are bound as AAD, so a
 *     ciphertext copied onto another row or another user fails to decrypt.
 *  2. No HTTP route returns secret material: the API surface is create / list-metadata / delete.
 *  3. The model never sees a secret. It refers to an item by id; the browser agent's fill tool calls
 *     `reveal()` at the moment of typing, only after the origin check and an approval, and the value
 *     goes straight into the page. Tool results and logs carry the label, never the value.
 */

export type VaultPayload =
  | { kind: 'login'; username: string; password: string }
  | { kind: 'card'; number: string; expMonth: string; expYear: string; cvc: string; nameOnCard: string }
  | { kind: 'note'; text: string };

function userKey(userId: Id): Buffer {
  const salt = users.vaultSalt(userId);
  if (!salt) throw new Error('user not found');
  return Buffer.from(hkdfSync('sha256', masterKey(), salt, 'vector-vault-v1', 32));
}

function encrypt(userId: Id, aad: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', userKey(userId), iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(userId: Id, aad: string, blob: string): string {
  const [v, iv, tag, ct] = blob.split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unrecognised vault ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', userKey(userId), Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

/** Normalise user input to a bare origin (scheme://host[:port]); only https, or http on localhost. */
export function normalizeOrigin(input: string): string {
  const raw = input.trim();
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Saved logins must use an https:// site.');
  return url.origin;
}

/**
 * May a secret bound to `itemOrigin` be typed into `pageUrl`? Same scheme and port, and the page host
 * is the saved host or a subdomain of it. Guards against a look-alike or redirected page harvesting a login.
 */
export function originAllows(itemOrigin: string, pageUrl: string): boolean {
  try {
    const item = new URL(itemOrigin);
    const page = new URL(pageUrl);
    if (item.protocol !== page.protocol || item.port !== page.port) return false;
    return page.hostname === item.hostname || page.hostname.endsWith(`.${item.hostname}`);
  } catch {
    return false;
  }
}

function mask(value: string, keepStart = 1): string {
  const [name, domain] = value.split('@');
  if (domain) return `${name!.slice(0, keepStart)}•••@${domain}`;
  return value.length <= 2 ? '••' : `${value.slice(0, keepStart)}•••`;
}

export const vault = {
  list(userId: Id): VaultItem[] {
    return vaultRows.list(userId);
  },

  create(userId: Id, body: VaultCreateBody): VaultItem {
    let payload: VaultPayload;
    let origin = '';
    let hint = '';
    if (body.kind === 'login') {
      origin = normalizeOrigin(body.origin);
      payload = { kind: 'login', username: body.username, password: body.password };
      hint = mask(body.username);
    } else if (body.kind === 'card') {
      const number = body.number.replace(/[\s-]/g, '');
      if (!/^\d{12,19}$/.test(number)) throw new Error('That card number does not look right.');
      payload = { kind: 'card', number, expMonth: body.expMonth, expYear: body.expYear, cvc: body.cvc, nameOnCard: body.nameOnCard };
      hint = `•••• ${number.slice(-4)}`;
    } else {
      payload = { kind: 'note', text: body.text };
      hint = 'secure note';
    }
    // Insert with a placeholder first so the row id can be bound into the ciphertext as AAD.
    const item = vaultRows.insert(userId, { kind: body.kind, label: body.label, origin, hint, payloadEnc: 'pending' });
    const enc = encrypt(userId, `${userId}:${item.id}`, JSON.stringify(payload));
    vaultRows.setPayload(userId, item.id, enc);
    audit(userId, 'vault.item_added', { itemId: item.id, kind: body.kind, label: item.label, origin });
    return item;
  },

  remove(userId: Id, id: Id): boolean {
    const ok = vaultRows.delete(userId, id);
    if (ok) audit(userId, 'vault.item_removed', { itemId: id });
    return ok;
  },

  /**
   * Decrypt one item. INTERNAL: the only legitimate caller is the browser agent's fill tool, after the
   * origin check and an approval. Never return the result to the model, the client, or a log.
   */
  reveal(userId: Id, id: Id, purpose: { usedOn: string; runId?: Id }): VaultPayload | null {
    const row = vaultRows.get(userId, id);
    if (!row) return null;
    const payload = JSON.parse(decrypt(userId, `${userId}:${row.id}`, row.payloadEnc)) as VaultPayload;
    audit(userId, 'vault.item_used', { itemId: id, label: row.label, ...purpose });
    return payload;
  },
};
