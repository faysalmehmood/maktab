/**
 * `npm run backup:keygen -w @maktab/db [-- --out <file>]`: makes the age key pair the nightly backup
 * is encrypted to (PLAN §9; docs/backup.md). No `age` binary needed: the official `age-encryption`
 * package (a devDependency here) generates a standard X25519 identity, the kind the `age` CLI on the
 * GitHub runner (Ubuntu's age 1.1) reads.
 *
 * - The PRIVATE key is written only to the output file (default ~/Homelab/maktab-backup-key.txt),
 *   mode 0600, in the same format `age-keygen` writes. An existing file is never overwritten.
 * - Only the PUBLIC recipient (`age1…`) is printed: it goes into the GitHub secret AGE_RECIPIENT.
 *
 * Give the key file to the two trustees (password manager / USB in a safe) and keep it off servers,
 * GitHub and chat. The restore-drill workflow needs it as the secret AGE_SECRET_KEY in a protected
 * GitHub environment (docs/backup.md).
 */
import { closeSync, constants, mkdirSync, openSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';

const args = process.argv.slice(2);
const at = args.indexOf('--out');
const out = resolve(
  at >= 0 && args[at + 1] ? (args[at + 1] as string) : `${homedir()}/Homelab/maktab-backup-key.txt`,
);

const identity = await generateX25519Identity();
const recipient = await identityToRecipient(identity);

mkdirSync(dirname(out), { recursive: true });
let fd: number;
try {
  // O_EXCL: fails if the file exists, so a key the backups depend on is never replaced.
  fd = openSync(out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
    console.error(`refusing to overwrite ${out}: it may hold the key existing backups need.`);
    process.exit(1);
  }
  throw err;
}
writeSync(fd, `# created: ${new Date().toISOString()}\n# public key: ${recipient}\n${identity}\n`);
closeSync(fd);

console.error(`private key written to ${out} (mode 0600). Keep it offline with the trustees.`);
console.log(recipient);
