/**
 * Real conversion with sharp + ffmpeg (libx265), verified with ffprobe against the official
 * story requirements. Needs `sharp` installed, an ffmpeg binary (FFMPEG_PATH or ffmpeg-static) and ffprobe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FfmpegSharpPreparer, STORY_PHOTO, STORY_VIDEO } from '../../src/modules/stories/media-prep.js';

async function ffmpegPath(): Promise<string | null> {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return ((await import('ffmpeg-static')) as unknown as { default: string | null }).default;
  } catch {
    return null;
  }
}
const hasFfprobe = spawnSync('ffprobe', ['-version']).status === 0;

function probe(file: string, args: string[]) {
  const r = spawnSync('ffprobe', ['-v', 'error', ...args, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/** Top-level MP4 box order — "streamable" means moov comes before mdat. */
function topBoxes(buf: Buffer): string[] {
  const out: string[] = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(off + 8));
    out.push(type);
    if (size < 8) break;
    off += size;
  }
  return out;
}

test('photo → exactly 1080x1920 JPEG ≤ 10 MB', async () => {
  const sharp = ((await import('sharp')) as unknown as { default: (o: unknown) => { png(): { toBuffer(): Promise<Buffer> } } }).default;
  const landscape = await sharp({ create: { width: 1280, height: 720, channels: 3, background: { r: 200, g: 50, b: 50 } } }).png().toBuffer();
  const prep = new FfmpegSharpPreparer('ffmpeg');
  const out = await prep.photo(new Uint8Array(landscape));
  const meta = await ((await import('sharp')) as unknown as { default: (b: Uint8Array) => { metadata(): Promise<{ width: number; height: number; format: string }> } }).default(out.data).metadata();
  assert.equal(meta.width, STORY_PHOTO.width);
  assert.equal(meta.height, STORY_PHOTO.height);
  assert.equal(meta.format, 'jpeg');
  assert.ok(out.data.length <= STORY_PHOTO.maxBytes);
});

test('video → H.265 720x1280, key frame every second, faststart, ≤ 30 MB, ≤ 60 s', async (t) => {
  const ff = await ffmpegPath();
  if (!ff || !hasFfprobe) return t.skip('ffmpeg/ffprobe not available');
  const dir = mkdtempSync(join(tmpdir(), 'vt-'));
  const src = join(dir, 'src.mp4');
  // 1280x720 H.264 with audio, like a typical phone video sent to the bot
  const gen = spawnSync(ff, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  assert.equal(gen.status, 0, gen.stderr?.toString());

  const prep = new FfmpegSharpPreparer(ff);
  const out = await prep.video(new Uint8Array(readFileSync(src)), 4);
  const dst = join(dir, 'out.mp4');
  writeFileSync(dst, out.data);

  const v = probe(dst, ['-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-of', 'csv=p=0']);
  assert.equal(v, 'hevc,720,1280,yuv420p');
  const fmt = probe(dst, ['-show_entries', 'format=format_name,duration', '-of', 'csv=p=0']);
  assert.match(fmt, /mp4/);
  assert.ok(Number(fmt.split(',').pop()) <= STORY_VIDEO.maxDuration);
  const keys = probe(dst, ['-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0'])
    .split('\n').map((l) => parseFloat(l));
  assert.ok(keys.length >= 4, `keyframes: ${keys}`);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i]! - keys[i - 1]! <= 1.05, `gap ${keys[i - 1]}→${keys[i]}`);
  const boxes = topBoxes(Buffer.from(out.data));
  assert.ok(boxes.indexOf('moov') < boxes.indexOf('mdat'), `boxes: ${boxes}`);
  assert.ok(out.data.length <= STORY_VIDEO.maxBytes);
  assert.equal(out.duration, 4);
  assert.equal(out.isAnimation, undefined, 'has audio → not an animation');
});

test('video without sound → is_animation', async (t) => {
  const ff = await ffmpegPath();
  if (!ff) return t.skip('ffmpeg not available');
  const dir = mkdtempSync(join(tmpdir(), 'vt-'));
  const src = join(dir, 'mute.mp4');
  const gen = spawnSync(ff, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=25:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
  assert.equal(gen.status, 0);
  const out = await new FfmpegSharpPreparer(ff).video(new Uint8Array(readFileSync(src)), 2);
  assert.equal(out.isAnimation, true);
});

test('broken input gives a clear error', async (t) => {
  const ff = await ffmpegPath();
  if (!ff) return t.skip('ffmpeg not available');
  await assert.rejects(new FfmpegSharpPreparer(ff).video(new Uint8Array([1, 2, 3])), /H\.265 formatiga o‘tkazib bo‘lmadi/);
});
