import { spawn } from 'node:child_process';
import { childEnv } from './env.ts';

// Runs a command with an argument array (never a shell string). Resolves with stdout; on a non-zero
// exit, a timeout or a spawn error throws an Error carrying the last lines of stderr.
export function run(cmd: string, args: string[], opts: { stdin?: string; timeoutMs: number; cwd?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], timeout: opts.timeoutMs });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new Error(`${cmd} failed to start: ${e.message}`)));
    p.on('close', (code, signal) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed (${signal ?? code}): ${err.trim().split('\n').slice(-5).join(' | ')}`));
    });
    p.stdin.on('error', () => {}); // the child may exit before reading stdin; the close handler reports it
    p.stdin.end(opts.stdin ?? '');
  });
}
