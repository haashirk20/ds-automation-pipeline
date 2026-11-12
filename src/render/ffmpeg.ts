import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

// Remotion ships FFmpeg 7.1 and ffprobe in its platform package, with their shared libraries beside
// them. It is a minimal build: no blackdetect, freezedetect, ebur128, overlay or drawtext.
const dir = path.dirname(createRequire(import.meta.url).resolve(`@remotion/compositor-${process.platform}-${process.arch}-gnu`));

// Runs the bundled binary with an argument array (never a shell string). Rejects on a non-zero exit.
export function ff(bin: 'ffmpeg' | 'ffprobe', args: string[], opts: { timeoutMs?: number } = {}): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      path.join(dir, bin),
      args,
      { encoding: 'buffer', timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LD_LIBRARY_PATH: dir } },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${bin} failed: ${stderr.toString().trim().split('\n').slice(-3).join(' | ') || err.message}`));
        else resolve({ stdout, stderr: stderr.toString() });
      },
    );
  });
}
