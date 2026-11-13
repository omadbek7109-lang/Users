import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Official requirements (Bot API, InputStoryContentPhoto / InputStoryContentVideo):
 *  - photo: exactly 1080x1920, ≤ 10 MB
 *  - video: 720x1280, streamable, H.265, key frame every second, MPEG4, ≤ 30 MB, duration 0–60 s
 * Media received from Telegram almost never matches, so it is converted before postStory.
 */
export const STORY_PHOTO = { width: 1080, height: 1920, maxBytes: 10 * 1024 * 1024 } as const;
export const STORY_VIDEO = { width: 720, height: 1280, maxBytes: 30 * 1024 * 1024, maxDuration: 60 } as const;

export interface PreparedMedia {
  data: Uint8Array;
  duration?: number;
  isAnimation?: boolean;
}

export interface StoryMediaPreparer {
  photo(input: Uint8Array): Promise<PreparedMedia>;
  video(input: Uint8Array, durationHint?: number): Promise<PreparedMedia>;
}

export class MediaPrepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaPrepError';
  }
}

type SharpFactory = (input: Uint8Array) => {
  rotate(): ReturnType<SharpFactory>;
  resize(w: number, h: number, o: { fit: 'cover'; position: 'attention' | 'centre' }): ReturnType<SharpFactory>;
  jpeg(o: { quality: number; mozjpeg?: boolean }): ReturnType<SharpFactory>;
  toBuffer(): Promise<Buffer>;
};

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => {
      clearTimeout(t);
      reject(new MediaPrepError(`ffmpeg ishga tushmadi: ${e.message}`));
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

/** Converts media with sharp (photos) and ffmpeg/libx265 (videos). */
export class FfmpegSharpPreparer implements StoryMediaPreparer {
  constructor(
    private readonly ffmpegPath: string,
    private readonly loadSharp: () => Promise<SharpFactory> = async () =>
      ((await import('sharp')) as unknown as { default: SharpFactory }).default,
    private readonly timeoutMs = 5 * 60_000,
  ) {}

  async photo(input: Uint8Array): Promise<PreparedMedia> {
    const sharp = await this.loadSharp();
    for (const quality of [90, 80, 70, 60]) {
      const out = await sharp(input)
        .rotate()
        .resize(STORY_PHOTO.width, STORY_PHOTO.height, { fit: 'cover', position: 'attention' })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (out.length <= STORY_PHOTO.maxBytes) return { data: new Uint8Array(out) };
    }
    throw new MediaPrepError('Rasmni 10 MB dan kichik qilib bo‘lmadi');
  }

  async video(input: Uint8Array, durationHint?: number): Promise<PreparedMedia> {
    const dir = await mkdtemp(join(tmpdir(), 'story-'));
    const src = join(dir, 'in');
    const dst = join(dir, 'out.mp4');
    try {
      await writeFile(src, input);
      for (const crf of [28, 32, 36]) {
        const { code, stderr } = await run(this.ffmpegPath, [
          '-hide_banner', '-y', '-i', src,
          '-t', String(STORY_VIDEO.maxDuration),
          '-vf', `scale=${STORY_VIDEO.width}:${STORY_VIDEO.height}:force_original_aspect_ratio=increase,crop=${STORY_VIDEO.width}:${STORY_VIDEO.height},fps=30`,
          '-c:v', 'libx265', '-preset', 'fast', '-crf', String(crf), '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p',
          '-force_key_frames', 'expr:gte(t,n_forced*1)', '-x265-params', 'scenecut=0:log-level=error',
          '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
          '-movflags', '+faststart',
          dst,
        ], this.timeoutMs);
        if (code !== 0) {
          const tail = stderr.split('\n').filter(Boolean).slice(-3).join(' | ');
          throw new MediaPrepError(`Videoni H.265 formatiga o‘tkazib bo‘lmadi: ${tail.slice(0, 300)}`);
        }
        const out = await readFile(dst);
        if (out.length <= STORY_VIDEO.maxBytes) {
          const hasAudio = /Stream #0:\d+.*: Audio:/.test(stderr.split('Output #0')[0] ?? '');
          const duration = durationHint !== undefined ? Math.min(Math.round(durationHint), STORY_VIDEO.maxDuration) : undefined;
          return { data: new Uint8Array(out), duration, isAnimation: hasAudio ? undefined : true };
        }
      }
      throw new MediaPrepError('Videoni 30 MB dan kichik qilib bo‘lmadi');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Test/dev preparer that leaves bytes untouched. */
export const passthroughPreparer: StoryMediaPreparer = {
  async photo(input) {
    return { data: input };
  },
  async video(input, durationHint) {
    return { data: input, duration: durationHint };
  },
};
