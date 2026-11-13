import { ff } from './ffmpeg.ts';

// Size and length of the clip, or null when it has no video stream.
export async function probeVideo(file: string): Promise<{ width: number; height: number; seconds: number } | null> {
  const r = JSON.parse((await ff('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])).stdout.toString());
  const v = (r.streams ?? []).find((x: { codec_type: string }) => x.codec_type === 'video');
  if (!v) return null;
  return { width: v.width, height: v.height, seconds: Number(r.format?.duration ?? v.duration ?? 0) };
}
