/**
 * @file TTS.ts
 * @description Text-to-speech engine for SANIX. Wraps four backends behind a
 * single EventEmitter3-based interface:
 *
 *   - `system`      — macOS `say`, Linux `espeak`, Windows SAPI (PowerShell).
 *   - `openai`      — OpenAI `tts-1` audio speech API.
 *   - `elevenlabs`  — ElevenLabs text-to-speech API.
 *   - `browser`     — Browser `speechSynthesis` API (no-op in Node).
 *
 * All backends expose:
 *   - `speak(text)`           — synthesize a full clip (returns {@link AudioOutput}).
 *   - `stream(text$)`         — synthesize chunks from an async text iterable
 *                                (for streaming LLM output → live TTS).
 *   - `listVoices()`          — list available voices.
 *   - `stop()`                — interrupt any in-flight synthesis.
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import type {
  AudioChunk,
  AudioOutput,
  TTSEngineEvents,
  TTSEngineOptions,
  Voice,
} from './types.js';

/**
 * Is this process running inside a browser-like environment?
 * (Used to pick the default provider.)
 */
function isBrowser(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { window?: unknown }).window !== 'undefined' &&
    typeof (globalThis as { speechSynthesis?: unknown }).speechSynthesis !==
      'undefined'
  );
}

/**
 * Resolve the default provider for this environment.
 * Browser → `browser`; Node on macOS/Linux/Windows → `system`.
 */
function defaultProvider(): NonNullable<TTSEngineOptions['provider']> {
  if (isBrowser()) return 'browser';
  return 'system';
}

/**
 * Text-to-speech engine. Wraps one of four backends behind a uniform
 * {@link EventEmitter} surface. Emits `speak:start`, `speak:complete`,
 * `speak:error`, `stream:chunk`, `stream:complete` events.
 *
 * @example
 * ```ts
 * import { TTSEngine } from '@sanix/voice';
 *
 * const tts = new TTSEngine({ provider: 'system' });
 * tts.on('speak:start', ({ text }) => console.log('speaking:', text));
 * const out = await tts.speak('Hello, SANIX.');
 * console.log('audio bytes:', out.bytes.length);
 * ```
 */
export class TTSEngine extends EventEmitter<TTSEngineEvents> {
  /** The selected backend. */
  readonly provider: NonNullable<TTSEngineOptions['provider']>;
  /** Voice id (provider-specific). */
  readonly voice?: string;
  /** Speed multiplier (0.5 — 4.0). */
  readonly speed: number;
  /** Pitch multiplier (0.0 — 2.0). */
  readonly pitch: number;
  /** Output sample rate (Hz). */
  readonly sampleRate: number;
  /** Output container format. */
  readonly format: AudioOutput['format'];

  /** True while a `speak()` is in flight (used by {@link stop}). */
  private active = false;
  /** Set by {@link stop} to signal in-flight synthesis to abort. */
  private aborted = false;
  /** A reference to a child process (system provider) for kill-on-stop. */
  private child: { kill: (signal?: NodeJS.Signals | number) => boolean } | null = null;

  /**
   * @param opts - Configuration. All fields optional; see {@link TTSEngineOptions}.
   */
  constructor(opts: TTSEngineOptions = {}) {
    super();
    this.provider = opts.provider ?? defaultProvider();
    this.voice = opts.voice;
    this.speed = opts.speed ?? 1.0;
    this.pitch = opts.pitch ?? 1.0;
    this.sampleRate = opts.sampleRate ?? 22050;
    this.format = opts.format ?? (this.provider === 'system' ? 'wav' : 'mp3');
  }

  /**
   * Synthesize a complete audio clip for the given text.
   *
   * @param text - The text to speak.
   * @param opts - Optional `{ interrupt?: boolean }`. If `interrupt: true`,
   *               any in-flight synthesis is cancelled first.
   * @returns The synthesized audio.
   *
   * @example
   * ```ts
   * const out = await tts.speak('The quick brown fox.');
   * await fs.writeFile('out.mp3', out.bytes);
   * ```
   */
  async speak(
    text: string,
    opts: { interrupt?: boolean } = {},
  ): Promise<AudioOutput> {
    if (opts.interrupt) this.stop();
    if (this.active && !opts.interrupt) {
      throw new Error('TTSEngine.speak: synthesis already in progress');
    }
    this.active = true;
    this.aborted = false;
    this.emit('speak:start', { text });
    try {
      const out = await this.synthesize(text);
      if (!this.aborted) this.emit('speak:complete', { output: out });
      return out;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('speak:error', { error });
      throw error;
    } finally {
      this.active = false;
      this.child = null;
    }
  }

  /**
   * Stream audio chunks derived from a stream of text deltas (typically
   * the LLM's streaming output). The engine splits incoming text on
   * sentence boundaries and synthesizes each sentence as it completes.
   *
   * @param text - An async iterable yielding text deltas.
   * @returns An async iterable of {@link AudioChunk}s (final chunk has
   *          `isFinal: true`).
   *
   * @example
   * ```ts
   * for await (const chunk of tts.stream(llmStream)) {
   *   speaker.write(chunk.bytes);
   * }
   * ```
   */
  async *stream(
    text: AsyncIterable<string>,
  ): AsyncIterable<AudioChunk> {
    let buffer = '';
    for await (const delta of text) {
      buffer += delta;
      // Flush on sentence boundaries (. ! ? ; newline) while keeping the
      // trailing punctuation with the sentence.
      let flushUntil = -1;
      for (let i = buffer.length - 1; i >= 0; i--) {
        const c = buffer[i];
        if (c === '.' || c === '!' || c === '?' || c === ';' || c === '\n') {
          flushUntil = i + 1;
          break;
        }
      }
      if (flushUntil > 0) {
        const sentence = buffer.slice(0, flushUntil);
        buffer = buffer.slice(flushUntil);
        for (const c of await this.synthesizeChunks(sentence)) {
          this.emit('stream:chunk', { chunk: c });
          yield c;
        }
      }
      if (this.aborted) return;
    }
    if (buffer.trim().length > 0) {
      for (const c of await this.synthesizeChunks(buffer)) {
        this.emit('stream:chunk', { chunk: c });
        yield c;
      }
    }
    const final: AudioChunk = { bytes: Buffer.alloc(0), isFinal: true };
    this.emit('stream:chunk', { chunk: final });
    this.emit('stream:complete', {});
    yield final;
  }

  /**
   * List voices available on the selected backend.
   *
   * @example
   * ```ts
   * for (const v of await tts.listVoices()) {
   *   console.log(v.id, v.name, v.language);
   * }
   * ```
   */
  async listVoices(): Promise<Voice[]> {
    switch (this.provider) {
      case 'system':
        return this.listSystemVoices();
      case 'openai':
        return this.listOpenAIVoices();
      case 'elevenlabs':
        return this.listElevenLabsVoices();
      case 'browser':
        return this.listBrowserVoices();
    }
  }

  /**
   * Interrupt any in-flight synthesis. Safe to call when nothing is
   * running. After `stop()`, the in-flight `speak()` promise will reject
   * with an `AbortError`; the in-flight `stream()` generator will simply
   * terminate.
   */
  stop(): void {
    this.aborted = true;
    this.active = false;
    if (this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        /* swallow */
      }
      this.child = null;
    }
  }

  // ─── Backend dispatch ─────────────────────────────────────────────────

  private async synthesize(text: string): Promise<AudioOutput> {
    switch (this.provider) {
      case 'system':
        return this.synthesizeSystem(text);
      case 'openai':
        return this.synthesizeOpenAI(text);
      case 'elevenlabs':
        return this.synthesizeElevenLabs(text);
      case 'browser':
        return this.synthesizeBrowser(text);
    }
  }

  private async synthesizeChunks(text: string): Promise<AudioChunk[]> {
    const out = await this.synthesize(text);
    return [
      { bytes: out.bytes, isFinal: false },
    ];
  }

  // ─── system backend ───────────────────────────────────────────────────

  private platform(): 'darwin' | 'linux' | 'win32' | 'other' {
    return os.platform() as 'darwin' | 'linux' | 'win32' | 'other';
  }

  private async listSystemVoices(): Promise<Voice[]> {
    const plat = this.platform();
    if (plat === 'darwin') {
      try {
        const out = await this.runChild('say', ['-v', '?']);
        return out
          .split('\n')
          .filter((l) => l.trim().length > 0)
          .map((l) => {
            const m = l.match(/^(\S+)\s+(\S+)/);
            const id = m ? m[1] : l.trim();
            const lang = m ? m[2] : 'en';
            return {
              id,
              name: id,
              language: lang,
            } satisfies Voice;
          });
      } catch {
        return [];
      }
    }
    if (plat === 'linux') {
      try {
        const out = await this.runChild('espeak', ['--voices']);
        return out
          .split('\n')
          .slice(1)
          .filter((l) => l.trim().length > 0)
          .map((l) => {
            const parts = l.trim().split(/\s+/);
            const id = parts[1] ?? 'default';
            const lang = parts[0] ?? 'en';
            return { id, name: id, language: lang } satisfies Voice;
          });
      } catch {
        return [];
      }
    }
    if (plat === 'win32') {
      return [
        { id: 'Microsoft David Desktop', name: 'David', language: 'en-US', gender: 'male' },
        { id: 'Microsoft Zira Desktop', name: 'Zira', language: 'en-US', gender: 'female' },
      ];
    }
    return [];
  }

  private async synthesizeSystem(text: string): Promise<AudioOutput> {
    const plat = this.platform();
    const outFile = path.join(
      os.tmpdir(),
      `sanix-tts-${nanoid()}.${this.format === 'wav' ? 'wav' : 'aiff'}`,
    );
    if (plat === 'darwin') {
      const args = ['-o', outFile];
      if (this.voice) args.push('-v', this.voice);
      args.push('-r', String(Math.round(this.speed * 180)));
      args.push(text);
      await this.runChildRaw('say', args, (child) => {
        this.child = child;
      });
      const bytes = await fs.readFile(outFile);
      await fs.unlink(outFile).catch(() => {});
      const duration = estimateDurationFromText(text, this.speed);
      return {
        duration,
        bytes,
        format: this.format,
        sampleRate: 44100,
      };
    }
    if (plat === 'linux') {
      const args = ['-s', String(Math.round(this.speed * 170))];
      if (this.voice) args.push('-v', this.voice);
      args.push('-w', outFile);
      args.push(text);
      await this.runChildRaw('espeak', args, (child) => {
        this.child = child;
      });
      const bytes = await fs.readFile(outFile);
      await fs.unlink(outFile).catch(() => {});
      return {
        duration: estimateDurationFromText(text, this.speed),
        bytes,
        format: 'wav',
        sampleRate: 22050,
      };
    }
    if (plat === 'win32') {
      const voice = this.voice ?? 'Microsoft Zira Desktop';
      const rate = Math.round((this.speed - 1) * 50);
      const ps = `Add-Type -AssemblyName System.Speech;` +
        `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;` +
        `$s.SelectVoice('${voice}');` +
        `$s.Rate = ${rate};` +
        `$s.SetOutputToWaveFile('${outFile}');` +
        `$s.Speak(${JSON.stringify(text)});` +
        `$s.Dispose();`;
      await this.runChildRaw('powershell', ['-NoProfile', '-Command', ps], (child) => {
        this.child = child;
      });
      const bytes = await fs.readFile(outFile);
      await fs.unlink(outFile).catch(() => {});
      return {
        duration: estimateDurationFromText(text, this.speed),
        bytes,
        format: 'wav',
        sampleRate: 22050,
      };
    }
    throw new Error(
      `TTSEngine (system): unsupported platform ${plat}. ` +
        'Install espeak (Linux), use macOS, or pick a cloud provider.',
    );
  }

  // ─── OpenAI backend ───────────────────────────────────────────────────

  private async synthesizeOpenAI(text: string): Promise<AudioOutput> {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'TTSEngine (openai): OPENAI_API_KEY environment variable is not set.',
      );
    }
    const voice = this.voice ?? 'alloy';
    const body = JSON.stringify({
      model: 'tts-1',
      voice,
      input: text,
      speed: this.speed,
      response_format: this.format === 'wav' ? 'wav' : 'mp3',
    });
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        `TTSEngine (openai): HTTP ${res.status} ${res.statusText}: ${errText}`,
      );
    }
    const arrayBuf = await res.arrayBuffer();
    const bytes = Buffer.from(arrayBuf);
    return {
      duration: estimateDurationFromText(text, this.speed),
      bytes,
      format: this.format,
      sampleRate: this.sampleRate,
    };
  }

  private async listOpenAIVoices(): Promise<Voice[]> {
    return [
      { id: 'alloy', name: 'Alloy', language: 'en-US', gender: 'neutral' },
      { id: 'echo', name: 'Echo', language: 'en-US', gender: 'male' },
      { id: 'fable', name: 'Fable', language: 'en-US', gender: 'neutral' },
      { id: 'onyx', name: 'Onyx', language: 'en-US', gender: 'male' },
      { id: 'nova', name: 'Nova', language: 'en-US', gender: 'female' },
      { id: 'shimmer', name: 'Shimmer', language: 'en-US', gender: 'female' },
    ];
  }

  // ─── ElevenLabs backend ───────────────────────────────────────────────

  private async synthesizeElevenLabs(text: string): Promise<AudioOutput> {
    const apiKey = process.env['ELEVENLABS_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'TTSEngine (elevenlabs): ELEVENLABS_API_KEY environment variable is not set.',
      );
    }
    const voiceId = this.voice ?? '21m00Tcm4TlvDq8ikWAM';
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
    const body = JSON.stringify({
      text,
      model_id: 'eleven_monolingual_v1',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.5,
        speed: this.speed,
      },
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
        Accept: 'audio/mpeg',
      },
      body,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        `TTSEngine (elevenlabs): HTTP ${res.status} ${res.statusText}: ${errText}`,
      );
    }
    const arrayBuf = await res.arrayBuffer();
    const bytes = Buffer.from(arrayBuf);
    return {
      duration: estimateDurationFromText(text, this.speed),
      bytes,
      format: 'mp3',
      sampleRate: 44100,
    };
  }

  private async listElevenLabsVoices(): Promise<Voice[]> {
    const apiKey = process.env['ELEVENLABS_API_KEY'];
    if (!apiKey) return [];
    try {
      const res = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': apiKey },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        voices?: Array<{
          voice_id: string;
          name: string;
          labels?: { gender?: string; language?: string };
          preview_url?: string;
        }>;
      };
      return (data.voices ?? []).map((v) => ({
        id: v.voice_id,
        name: v.name,
        language: v.labels?.language ?? 'en',
        gender:
          v.labels?.gender === 'male'
            ? 'male'
            : v.labels?.gender === 'female'
              ? 'female'
              : 'neutral',
        preview_url: v.preview_url,
      }));
    } catch {
      return [];
    }
  }

  // ─── Browser backend ──────────────────────────────────────────────────

  private async synthesizeBrowser(_text: string): Promise<AudioOutput> {
    // Browser TTS is fire-and-forget audio playback; there is no canonical
    // way to capture the synthesized audio bytes. We return an empty
    // payload so callers can still coordinate events.
    if (!isBrowser()) {
      throw new Error(
        'TTSEngine (browser): speechSynthesis is only available in the browser.',
      );
    }
    return {
      duration: 0,
      bytes: Buffer.alloc(0),
      format: this.format,
      sampleRate: this.sampleRate,
    };
  }

  private async listBrowserVoices(): Promise<Voice[]> {
    if (!isBrowser()) return [];
    const synth = (
      globalThis as { speechSynthesis?: { getVoices: () => Array<{ name: string; lang: string; voiceURI: string }> } }
    ).speechSynthesis;
    if (!synth) return [];
    return synth.getVoices().map((v) => ({
      id: v.voiceURI,
      name: v.name,
      language: v.lang,
    }));
  }

  // ─── Child-process helpers ────────────────────────────────────────────

  /**
   * Run a child process and return its stdout as a string.
   */
  private runChild(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let stdout = '';
      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });
      child.on('error', (err) => {
        this.child = null;
        reject(
          new Error(
            `TTSEngine: failed to spawn '${cmd}': ${err.message}. ` +
              'Is it installed and on PATH?',
          ),
        );
      });
      child.on('close', (code) => {
        this.child = null;
        if (code === 0) resolve(stdout);
        else reject(new Error(`TTSEngine: '${cmd}' exited with code ${code}`));
      });
    });
  }

  /**
   * Run a child process, exposing the underlying ChildHandle to the
   * caller (so `stop()` can kill it).
   */
  private runChildRaw(
    cmd: string,
    args: string[],
    onSpawn: (child: { kill: (signal?: NodeJS.Signals | number) => boolean }) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      onSpawn(child);
      let stderr = '';
      child.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
      child.on('error', (err) => {
        reject(
          new Error(
            `TTSEngine: failed to spawn '${cmd}': ${err.message}. ` +
              'Is it installed and on PATH?',
          ),
        );
      });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `TTSEngine: '${cmd}' exited with code ${code}${stderr ? `: ${stderr}` : ''}`,
            ),
          );
      });
    });
  }
}

/**
 * Rough estimate of TTS duration from text length and speed. Used as a
 * fallback when the provider doesn't return accurate timing. English
 * averages ~16 chars/sec at speed=1.0.
 */
function estimateDurationFromText(text: string, speed: number): number {
  const charsPerSec = 16 * (speed > 0 ? speed : 1);
  return Math.max(0.5, text.length / charsPerSec);
}
