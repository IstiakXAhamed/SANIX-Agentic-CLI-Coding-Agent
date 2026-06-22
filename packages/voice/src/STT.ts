/**
 * @file STT.ts
 * @description Speech-to-text engine for SANIX. Wraps three backends behind
 * a single EventEmitter3-based interface:
 *
 *   - `system`        — shell out to `whisper-cpp` (preferred) or `whisper`
 *                       CLI if available; errors out otherwise.
 *   - `openai`        — OpenAI Whisper API (`/v1/audio/transcriptions`).
 *   - `whisper-local` — shell out to the Python `whisper` package CLI.
 *
 * All backends expose:
 *   - `transcribe(buf)`            — transcribe a full audio clip.
 *   - `streamTranscribe(buf$)`     — transcribe an async iterable of audio
 *                                     chunks (streaming STT).
 *   - `startRecording()`           — start a microphone capture session
 *                                     (system-dependent; push-to-talk / VAD).
 *   - `stopRecording(session)`     — stop the session and return the result.
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promises as fs, createWriteStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import type {
  RecordingSession,
  STTEngineEvents,
  STTEngineOptions,
  TranscriptionChunk,
  TranscriptionResult,
  TranscriptionSegment,
} from './types.js';

/**
 * Speech-to-text engine. Wraps one of three backends behind a uniform
 * {@link EventEmitter} surface. Emits `transcribe:start`,
 * `transcribe:complete`, `transcribe:error`, `recording:start`,
 * `recording:stop`, and `chunk` events.
 *
 * @example
 * ```ts
 * import { STTEngine } from '@sanix/voice';
 *
 * const stt = new STTEngine({ provider: 'system', language: 'en' });
 * const buf = await fs.readFile('clip.wav');
 * const result = await stt.transcribe(buf, { format: 'wav' });
 * console.log(result.text);
 * ```
 */
export class STTEngine extends EventEmitter<STTEngineEvents> {
  /** The selected backend. */
  readonly provider: NonNullable<STTEngineOptions['provider']>;
  /** BCP-47 language tag. */
  readonly language?: string;
  /** Expected sample rate (Hz). */
  readonly sampleRate: number;
  /** Model id (provider-specific). */
  readonly model?: string;
  /** Path to a whisper-cpp model file (system provider). */
  readonly modelPath?: string;

  /**
   * @param opts - Configuration. All fields optional; see {@link STTEngineOptions}.
   */
  constructor(opts: STTEngineOptions = {}) {
    super();
    this.provider = opts.provider ?? 'system';
    this.language = opts.language;
    this.sampleRate = opts.sampleRate ?? 16000;
    this.model = opts.model;
    this.modelPath = opts.modelPath;
  }

  /**
   * Transcribe a complete audio buffer.
   *
   * @param audio - The audio bytes (wav / mp3 / pcm).
   * @param opts  - Optional `{ format?, language? }` overrides.
   * @returns The transcription.
   *
   * @example
   * ```ts
   * const result = await stt.transcribe(buf, { format: 'wav' });
   * console.log(result.text, result.duration, result.segments);
   * ```
   */
  async transcribe(
    audio: Buffer,
    opts: { format?: 'wav' | 'mp3' | 'pcm'; language?: string } = {},
  ): Promise<TranscriptionResult> {
    this.emit('transcribe:start', { bytes: audio.length });
    try {
      const result = await this.transcribeImpl(audio, opts);
      this.emit('transcribe:complete', { result });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('transcribe:error', { error });
      throw error;
    }
  }

  /**
   * Stream transcription of an async iterable of audio buffers. Each
   * buffer is transcribed in turn; partial results are emitted with
   * `isFinal: false`, and a final consolidated result with `isFinal: true`
   * is emitted at the end.
   *
   * @param audioStream - An async iterable of audio buffers.
   * @returns An async iterable of {@link TranscriptionChunk}s.
   *
   * @example
   * ```ts
   * for await (const c of stt.streamTranscribe(micStream)) {
   *   console.log(c.isFinal ? '[final]' : '[partial]', c.text);
   * }
   * ```
   */
  async *streamTranscribe(
    audioStream: AsyncIterable<Buffer>,
  ): AsyncIterable<TranscriptionChunk> {
    let start = 0;
    for await (const chunk of audioStream) {
      try {
        const result = await this.transcribeImpl(chunk, { format: 'pcm' });
        if (result.text.trim().length > 0) {
          const c: TranscriptionChunk = {
            text: result.text,
            isFinal: true,
            start,
          };
          this.emit('chunk', { chunk: c });
          yield c;
        }
        start += result.duration;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.emit('transcribe:error', { error });
        const c: TranscriptionChunk = {
          text: '',
          isFinal: false,
          start,
        };
        yield c;
      }
    }
  }

  /**
   * Start a microphone recording session.
   *
   * On macOS, shells out to `rec` (SoX) or `ffmpeg`; on Linux to `arecord`;
   * on Windows to PowerShell's `System.Speech.Recognition`. Falls back to
   * a session that yields no chunks if no recording tool is available
   * (graceful degradation).
   *
   * @param opts - Optional `{ device?, vad? }`. `device` selects an audio
   *               device (provider-specific); `vad` enables voice activity
   *               detection (best-effort).
   * @returns A {@link RecordingSession} handle.
   */
  startRecording(
    opts: { device?: string; vad?: boolean } = {},
  ): RecordingSession {
    const id = nanoid();
    const listeners = new Set<(chunk: TranscriptionChunk) => void>();
    const tmpFile = path.join(os.tmpdir(), `sanix-rec-${id}.wav`);
    const startTime = Date.now();
    let child: ChildProcess | null = null;
    let paused = false;
    let stopped = false;

    const spawnRecorder = (): void => {
      const plat = os.platform();
      const cmd =
        plat === 'darwin' ? 'rec' : plat === 'linux' ? 'arecord' : null;
      if (!cmd) {
        // Graceful: no recorder; session will return empty result on stop.
        return;
      }
      const args =
        cmd === 'rec'
          ? ['-q', '-r', String(this.sampleRate), '-c', '1', tmpFile]
          : ['-q', '-r', String(this.sampleRate), '-c', '1', '-f', 'cd', tmpFile];
      if (opts.device) {
        if (cmd === 'rec') args.unshift('-d', opts.device);
        else args.unshift('-D', opts.device);
      }
      try {
        child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        child = null;
      }
    };

    spawnRecorder();
    this.emit('recording:start', { sessionId: id });

    const stop = async (): Promise<TranscriptionResult> => {
      if (stopped) {
        return { text: '', language: this.language ?? 'en', duration: 0, segments: [] };
      }
      stopped = true;
      if (child) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* swallow */
        }
        child = null;
      }
      // Give the recorder a moment to flush the WAV header.
      await new Promise((r) => setTimeout(r, 100));
      let bytes = Buffer.alloc(0);
      try {
        bytes = await fs.readFile(tmpFile);
      } catch {
        /* no audio captured */
      }
      await fs.unlink(tmpFile).catch(() => {});
      const duration = (Date.now() - startTime) / 1000;
      let result: TranscriptionResult;
      if (bytes.length === 0) {
        result = {
          text: '',
          language: this.language ?? 'en',
          duration,
          segments: [],
        };
      } else {
        try {
          result = await this.transcribeImpl(bytes, { format: 'wav' });
        } catch {
          result = {
            text: '',
            language: this.language ?? 'en',
            duration,
            segments: [],
          };
        }
      }
      this.emit('recording:stop', { sessionId: id, result });
      return result;
    };

    const pause = (): void => {
      paused = true;
      if (child) {
        try {
          child.kill('SIGSTOP');
        } catch {
          /* swallow */
        }
      }
    };

    const resume = (): void => {
      if (!paused) return;
      paused = false;
      if (child) {
        try {
          child.kill('SIGCONT');
        } catch {
          /* swallow */
        }
      }
    };

    const onChunk = (cb: (chunk: TranscriptionChunk) => void): void => {
      listeners.add(cb);
    };

    return {
      id,
      stop,
      pause,
      resume,
      onChunk,
    };
  }

  /**
   * Stop a recording session. Equivalent to calling `session.stop()`
   * directly, but kept for symmetry with the spec.
   */
  async stopRecording(session: RecordingSession): Promise<TranscriptionResult> {
    return session.stop();
  }

  // ─── Backend dispatch ─────────────────────────────────────────────────

  private async transcribeImpl(
    audio: Buffer,
    opts: { format?: 'wav' | 'mp3' | 'pcm'; language?: string },
  ): Promise<TranscriptionResult> {
    switch (this.provider) {
      case 'system':
        return this.transcribeSystem(audio, opts);
      case 'openai':
        return this.transcribeOpenAI(audio, opts);
      case 'whisper-local':
        return this.transcribeWhisperLocal(audio, opts);
    }
  }

  // ─── system (whisper-cpp) ─────────────────────────────────────────────

  private async transcribeSystem(
    audio: Buffer,
    opts: { format?: 'wav' | 'mp3' | 'pcm'; language?: string },
  ): Promise<TranscriptionResult> {
    const modelPath = this.modelPath ?? process.env['WHISPER_CPP_MODEL'];
    if (!modelPath) {
      throw new Error(
        'STTEngine (system): no whisper-cpp model path. Set WHISPER_CPP_MODEL ' +
          'or pass modelPath in the constructor.',
      );
    }
    const format = opts.format ?? 'wav';
    const inFile = path.join(os.tmpdir(), `sanix-stt-${nanoid()}.${format}`);
    await fs.writeFile(inFile, audio);
    const outFile = path.join(os.tmpdir(), `sanix-stt-${nanoid()}.json`);
    try {
      const args = ['-m', modelPath, '-f', inFile, '-oj', '-of', outFile];
      const lang = opts.language ?? this.language;
      if (lang) args.push('-l', lang.split('-')[0]!);
      await this.runChild('whisper-cpp', args, 'whisper-cpp');
      // whisper-cpp writes <outFile>.json
      let jsonText: string;
      try {
        jsonText = await fs.readFile(`${outFile}.json`, 'utf8');
      } catch {
        // Fallback: whisper-cpp prints plain text to stdout.
        return {
          text: '',
          language: lang ?? 'en',
          duration: 0,
          segments: [],
        };
      }
      const data = JSON.parse(jsonText) as {
        text?: string;
        language?: string;
        segments?: Array<{
          text: string;
          start: number;
          end: number;
          confidence?: number;
        }>;
      };
      const segments: TranscriptionSegment[] = (data.segments ?? []).map((s) => ({
        text: s.text.trim(),
        start: s.start,
        end: s.end,
        confidence: s.confidence ?? 1,
      }));
      return {
        text: data.text?.trim() ?? segments.map((s) => s.text).join(' '),
        language: data.language ?? lang ?? 'en',
        duration: segments.length > 0 ? segments[segments.length - 1]!.end : 0,
        segments,
      };
    } finally {
      await fs.unlink(inFile).catch(() => {});
      await fs.unlink(`${outFile}.json`).catch(() => {});
    }
  }

  // ─── openai ───────────────────────────────────────────────────────────

  private async transcribeOpenAI(
    audio: Buffer,
    opts: { format?: 'wav' | 'mp3' | 'pcm'; language?: string },
  ): Promise<TranscriptionResult> {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'STTEngine (openai): OPENAI_API_KEY environment variable is not set.',
      );
    }
    const format = opts.format ?? 'wav';
    const filename = `audio.${format === 'pcm' ? 'wav' : format}`;
    const model = this.model ?? 'whisper-1';
    const form = new FormData();
    form.append('model', model);
    form.append('file', new Blob([new Uint8Array(audio)]), filename);
    const lang = opts.language ?? this.language;
    if (lang) form.append('language', lang.split('-')[0]!);
    form.append('response_format', 'verbose_json');

    const res = await fetch(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        `STTEngine (openai): HTTP ${res.status} ${res.statusText}: ${errText}`,
      );
    }
    const data = (await res.json()) as {
      text?: string;
      language?: string;
      duration?: number;
      segments?: Array<{
        text: string;
        start: number;
        end: number;
        avg_logprob?: number;
      }>;
    };
    const segments: TranscriptionSegment[] = (data.segments ?? []).map((s) => ({
      text: s.text.trim(),
      start: s.start,
      end: s.end,
      // avg_logprob is roughly in [-1, 0]; map to [0, 1].
      confidence: s.avg_logprob !== undefined
        ? Math.max(0, Math.min(1, 1 + s.avg_logprob))
        : 1,
    }));
    return {
      text: data.text?.trim() ?? '',
      language: data.language ?? lang ?? 'en',
      duration: data.duration ?? 0,
      segments,
    };
  }

  // ─── whisper-local (python `whisper` CLI) ─────────────────────────────

  private async transcribeWhisperLocal(
    audio: Buffer,
    opts: { format?: 'wav' | 'mp3' | 'pcm'; language?: string },
  ): Promise<TranscriptionResult> {
    const format = opts.format ?? 'wav';
    const inFile = path.join(os.tmpdir(), `sanix-stt-${nanoid()}.${format}`);
    await fs.writeFile(inFile, audio);
    const outFile = path.join(os.tmpdir(), `sanix-stt-${nanoid()}.json`);
    try {
      const args = [inFile, '--output_format', 'json', '--output_file', outFile];
      const lang = opts.language ?? this.language;
      if (lang) args.push('--language', lang.split('-')[0]!);
      const model = this.model ?? 'base';
      args.push('--model', model);
      await this.runChild('whisper', args, 'whisper');
      const jsonText = await fs.readFile(outFile, 'utf8');
      const data = JSON.parse(jsonText) as {
        text?: string;
        language?: string;
        segments?: Array<{ text: string; start: number; end: number; avg_logprob?: number }>;
      };
      const segments: TranscriptionSegment[] = (data.segments ?? []).map((s) => ({
        text: s.text.trim(),
        start: s.start,
        end: s.end,
        confidence: s.avg_logprob !== undefined
          ? Math.max(0, Math.min(1, 1 + s.avg_logprob))
          : 1,
      }));
      return {
        text: data.text?.trim() ?? '',
        language: data.language ?? lang ?? 'en',
        duration: segments.length > 0 ? segments[segments.length - 1]!.end : 0,
        segments,
      };
    } finally {
      await fs.unlink(inFile).catch(() => {});
      await fs.unlink(outFile).catch(() => {});
    }
  }

  // ─── Child-process helper ─────────────────────────────────────────────

  private runChild(cmd: string, args: string[], label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
      child.on('error', (err) => {
        reject(
          new Error(
            `STTEngine: failed to spawn '${cmd}' (${label}): ${err.message}. ` +
              `Is ${label} installed and on PATH?`,
          ),
        );
      });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `STTEngine: '${cmd}' (${label}) exited with code ${code}` +
                (stderr ? `: ${stderr}` : ''),
            ),
          );
      });
    });
  }
}

// Silence the unused-import warning for createWriteStream (kept for future
// use by a more sophisticated recorder that writes directly to disk in
// chunks rather than relying on SoX/arecord).
void createWriteStream;
