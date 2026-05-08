// Terminal-side recovery for the admin account. Run inside the meet-api
// container when you've lost the password and/or all your passkeys:
//
//   docker compose exec meet-api node dist/reset-admin.js --help
//
// Operations are independent and composable:
//
//   --set-password [PASSWORD]     hash and store a new password; if
//                                 PASSWORD is omitted, read one line from
//                                 stdin (so `echo X | ... --set-password`
//                                 works in non-tty pipes)
//   --clear-passkeys              remove every registered passkey
//   --clear-sessions              invalidate every active admin session
//   --bootstrap                   reset first_login_done to 0 so the next
//                                 caller of /api/admin/login claims the
//                                 account (only safe over loopback / a
//                                 trusted reverse proxy)
//   --reset-all                   shorthand for the four above except
//                                 --set-password is interactive (or you
//                                 piped one in)
//
// The script connects to the same SQLite database as the running API
// (${MEET_DATA_DIR:-/data}/meet.db), so the better-sqlite3 WAL is shared
// — changes show up to the API immediately. No restart required.

import * as readline from 'readline';
import { getDb } from './db.js';
import * as store from './store.js';
import { hashPassword } from './auth.js';

interface Args {
  setPassword?: string | true;   // string = supplied; true = read stdin
  clearPasskeys?: boolean;
  clearSessions?: boolean;
  bootstrap?: boolean;
  resetAll?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--set-password') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out.setPassword = next;
        i++;
      } else {
        out.setPassword = true;
      }
    } else if (a === '--clear-passkeys') out.clearPasskeys = true;
    else if (a === '--clear-sessions') out.clearSessions = true;
    else if (a === '--bootstrap') out.bootstrap = true;
    else if (a === '--reset-all') out.resetAll = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(
    'Usage: node reset-admin.js [options]\n\n' +
      '  --set-password [PASSWORD]   set a new admin password (prompts/stdin if no arg)\n' +
      '  --clear-passkeys            remove all registered passkeys\n' +
      '  --clear-sessions            invalidate all active admin sessions\n' +
      '  --bootstrap                 reset first_login_done so the next /api/admin/login\n' +
      '                              claims the account (use over a trusted network only)\n' +
      '  --reset-all                 do all of the above (interactive password)\n' +
      '  --help                      this message\n',
  );
}

async function readPasswordFromStdin(): Promise<string> {
  // If stdin is a TTY, prompt with masking-ish behaviour (echoes a literal
  // *, since reliably hiding input here without a curses-style hack is
  // brittle). Otherwise read one line from a piped stdin.
  if (process.stdin.isTTY) {
    process.stdout.write('New admin password: ');
    process.stdin.setRawMode(true);
    const chars: string[] = [];
    return new Promise<string>((resolve) => {
      const onData = (b: Buffer) => {
        for (const c of b) {
          if (c === 13 || c === 10) {
            process.stdout.write('\n');
            process.stdin.removeListener('data', onData);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            resolve(chars.join(''));
            return;
          } else if (c === 3) {
            // Ctrl-C
            process.stdin.setRawMode(false);
            process.exit(130);
          } else if (c === 127 || c === 8) {
            // backspace
            if (chars.length) {
              chars.pop();
              process.stdout.write('\b \b');
            }
          } else {
            chars.push(String.fromCharCode(c));
            process.stdout.write('*');
          }
        }
      };
      process.stdin.on('data', onData);
      process.stdin.resume();
    });
  }
  // Non-tty: take one line.
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  return '';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (Object.keys(args).length === 0)) {
    printHelp();
    process.exit(args.help ? 0 : 2);
  }

  // Open DB (also runs any pending migrations).
  getDb();

  const did: string[] = [];

  const wantPassword = args.setPassword !== undefined || args.resetAll;
  const wantClearPasskeys = args.clearPasskeys || args.resetAll;
  const wantClearSessions = args.clearSessions || args.resetAll;
  const wantBootstrap = args.bootstrap || args.resetAll;

  if (wantPassword) {
    let password: string;
    if (typeof args.setPassword === 'string') {
      password = args.setPassword;
    } else {
      password = (await readPasswordFromStdin()).trim();
    }
    if (!password) {
      console.error('Refusing to set an empty password.');
      process.exit(1);
    }
    if (password.length < 8) {
      console.error('Refusing to set a password shorter than 8 characters.');
      process.exit(1);
    }
    const cred = store.loadAdminCredentials();
    store.saveAdminCredentials({
      username: cred.username || 'admin',
      passwordHash: hashPassword(password),
      firstLoginDone: true,
      userHandle: cred.userHandle,
    });
    did.push(`set new admin password (username: ${cred.username || 'admin'})`);
  }

  if (wantClearPasskeys) {
    const removed = store.deleteAllPasskeys();
    did.push(`removed ${removed} passkey(s)`);
  }

  if (wantClearSessions) {
    const db = getDb();
    const before = db.prepare('SELECT COUNT(*) AS c FROM admin_sessions').get() as { c: number };
    db.prepare('DELETE FROM admin_sessions').run();
    did.push(`invalidated ${before.c} active session(s)`);
  }

  if (wantBootstrap) {
    const cred = store.loadAdminCredentials();
    store.saveAdminCredentials({
      username: '',
      passwordHash: '',
      firstLoginDone: false,
      userHandle: cred.userHandle,
    });
    did.push('reset to first-login mode (next login claims the account)');
  }

  if (did.length === 0) {
    console.log('Nothing to do.');
    return;
  }
  for (const line of did) console.log(`✓ ${line}`);
}

main().catch((e) => {
  console.error('reset-admin failed:', e);
  process.exit(1);
});
