// Outbound email for one-time sign-in codes.
//
// A fresh nodemailer transport is built per send from the persisted SMTP
// settings. Sends are rare (one per admin sign-in) so there's nothing to
// gain from pooling, and rebuilding per call means a settings update takes
// effect immediately without a restart.

import nodemailer from 'nodemailer';
import type { SmtpSettings } from './types.js';

const APP_NAME = 'MEET';

// Everything the transport needs to actually deliver a message. Username /
// password are optional (relays on a trusted network commonly skip auth).
export function isSmtpComplete(s: SmtpSettings | null | undefined): s is SmtpSettings {
  return !!s
    && !!s.host
    && Number.isInteger(s.port) && s.port > 0 && s.port < 65536
    && !!s.fromAddress
    && !!s.adminEmail;
}

export function isValidEmail(v: string): boolean {
  // Deliberately loose: one "@", something either side, no whitespace.
  return typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

// "thomas@example.com" → "t***s@example.com". Shown on the login form so
// the admin knows which inbox to check without the API leaking the full
// address to anonymous callers.
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `${local[0]}***${domain}`;
  return `${local[0]}***${local[local.length - 1]}${domain}`;
}

function buildTransport(s: SmtpSettings) {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: s.username ? { user: s.username, pass: s.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

export type OtpPurpose = 'login' | 'verify';

export async function sendOtpEmail(
  s: SmtpSettings,
  code: string,
  purpose: OtpPurpose,
  ttlMinutes: number,
): Promise<void> {
  const subject = purpose === 'verify'
    ? `${APP_NAME}: confirm your email sign-in setup`
    : `${APP_NAME}: your sign-in code is ${code}`;
  const intro = purpose === 'verify'
    ? 'Enter this code in the MEET admin panel to confirm that email sign-in works. Once confirmed, password login is turned off and the admin account signs in with a passkey or an emailed code.'
    : 'Enter this code on the MEET admin sign-in screen.';
  const text = [
    `${intro}`,
    '',
    `Code: ${code}`,
    '',
    `It expires in ${ttlMinutes} minutes. If you didn't request it, you can ignore this email.`,
  ].join('\n');
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
      <h2 style="margin:0 0 12px;font-size:18px">${APP_NAME} sign-in code</h2>
      <p style="margin:0 0 16px;font-size:14px;line-height:1.5">${intro}</p>
      <p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${code}</p>
      <p style="margin:0;font-size:12px;color:#666">It expires in ${ttlMinutes} minutes. If you didn't request it, you can ignore this email.</p>
    </div>`;

  const transport = buildTransport(s);
  try {
    await transport.sendMail({
      from: s.fromAddress,
      to: s.adminEmail,
      subject,
      text,
      html,
    });
  } finally {
    transport.close();
  }
}
