/**
 * @file types.ts
 * @description Shared types for the `@sanix/voice` package — the contracts
 * every TTS/STT provider implements and the events the engines emit.
 *
 * All types are pure type declarations (no runtime values) so consumers can
 * import them via `import type { AudioOutput } from '@sanix/voice'` with
 * zero bundler overhead.
 *
 * @packageDocumentation
 */

/**
 * Supported audio container formats. `wav` is the canonical interchange
 * format for STT (lossless, universally supported by transcription
 * backends); `mp3` is the typical TTS output for cloud providers; `pcm`
 * is raw 16-bit signed little-endian mono samples (used by streaming
 * paths and local whisper-cpp).
 */
export type AudioFormat = 'wav' | 'mp3' | 'pcm';

/**
 * The complete output of a successful TTS `speak()` call. The `bytes`
 * buffer holds the full encoded audio (wav/mp3/pcm); `duration` is the
 * playback length in seconds; `sampleRate` is in Hz.
 *
 * @example
 * ```ts
 * const out: AudioOutput = await tts.speak('Hello, world.');
 * console.log(out.duration, out.format, out.bytes.length);
 * ```
 */
export interface AudioOutput {
  /** Playback duration in seconds. */
  duration: number;
  /** Encoded audio bytes (wav / mp3 / pcm). */
  bytes: Buffer;
  /** Container/encoding format of {@link bytes}. */
  format: AudioFormat;
  /** Sample rate in Hz (e.g. 22050, 44100). */
  sampleRate: number;
}

/**
 * A single chunk of audio produced by streaming TTS. The {@link isFinal}
 * flag is set on the last chunk so consumers can flush downstream sinks.
 */
export interface AudioChunk {
  /** A piece of encoded audio. */
  bytes: Buffer;
  /** `true` on the final chunk of a stream. */
  isFinal: boolean;
}

/**
 * A voice listing entry returned by {@link TTSEngine.listVoices}. Cloud
 * providers (OpenAI, ElevenLabs) populate all fields; system providers
 * populate a minimal subset.
 */
export interface Voice {
  /** Stable unique voice id (provider-specific). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** BCP-47 language tag (e.g. `en-US`, `ja-JP`) when known. */
  language: string;
  /** Perceived gender, when known. */
  gender?: 'male' | 'female' | 'neutral';
  /** Optional URL to a preview sample. */
  preview_url?: string;
}

/**
 * Constructor options for {@link TTSEngine}. All fields are optional;
 * sensible provider defaults apply when omitted.
 */
export interface TTSEngineOptions {
  /**
   * Which TTS backend to use.
   *
   * - `system`      — shell out to the OS's native TTS CLI
   *                   (macOS `say`, Linux `espeak`, Windows SAPI).
   * - `openai`      — `POST https://api.openai.com/v1/audio/speech`.
   * - `elevenlabs`  — `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`.
   * - `browser`     — use the browser `speechSynthesis` API (no-op in Node).
   *
   * Defaults to `system` in Node, `browser` if a `window` global is present.
   */
  provider?: 'system' | 'openai' | 'elevenlabs' | 'browser';
  /** Voice id (provider-specific). Defaults to the provider's first voice. */
  voice?: string;
  /** Speech rate multiplier (0.5 — 4.0; default 1.0). */
  speed?: number;
  /** Pitch multiplier (0.0 — 2.0; default 1.0; not all providers support). */
  pitch?: number;
  /** Output sample rate in Hz (default 22050 for cloud, system default otherwise). */
  sampleRate?: number;
  /** Output format (default `mp3` for cloud providers, `wav` for system). */
  format?: AudioFormat;
}

// ─── STT types ───────────────────────────────────────────────────────────────

/**
 * A single timestamped segment of a transcription. Most providers
 * (Whisper, Whisper.cpp) emit these; if a provider only returns plain
 * text, the result will have a single segment spanning `[0, duration]`.
 */
export interface TranscriptionSegment {
  /** The transcribed text for this segment. */
  text: string;
  /** Segment start time in seconds. */
  start: number;
  /** Segment end time in seconds. */
  end: number;
  /** Confidence in `[0, 1]` (1.0 = certain). Some providers omit. */
  confidence: number;
}

/**
 * Word-level timing information (when the provider supports it).
 * Useful for subtitles, karaoke, and voice-activity-driven UIs.
 */
export interface TranscriptionWord {
  /** The word (no surrounding whitespace). */
  word: string;
  /** Word start time in seconds. */
  start: number;
  /** Word end time in seconds. */
  end: number;
  /** Confidence in `[0, 1]`. */
  confidence: number;
}

/**
 * The complete result of a successful STT `transcribe()` call. Includes
 * the full text, detected language, total audio duration, and (when
 * available) segment + word-level timing.
 */
export interface TranscriptionResult {
  /** The full transcribed text (segments concatenated). */
  text: string;
  /** BCP-47 language tag of the detected/used language. */
  language: string;
  /** Total audio duration in seconds. */
  duration: number;
  /** Per-segment timing. */
  segments: TranscriptionSegment[];
  /** Word-level timing, when the provider supports it. */
  words?: TranscriptionWord[];
}

/**
 * A single chunk of transcription produced by streaming STT. The
 * {@link isFinal} flag distinguishes partial (in-progress) results
 * from finalized ones.
 */
export interface TranscriptionChunk {
  /** The transcribed text for this chunk. */
  text: string;
  /** `true` if the chunk is finalized (won't be revised). */
  isFinal: boolean;
  /** Chunk start time in seconds (from the start of the audio stream). */
  start: number;
}

/**
 * Constructor options for {@link STTEngine}.
 */
export interface STTEngineOptions {
  /**
   * Which STT backend to use.
   *
   * - `system`        — shell out to a locally-installed `whisper-cpp`
   *                      or `whisper` CLI (errors out if unavailable).
   * - `openai`        — `POST https://api.openai.com/v1/audio/transcriptions`.
   * - `whisper-local` — shell out to the Python `whisper` package CLI.
   */
  provider?: 'system' | 'openai' | 'whisper-local';
  /** BCP-47 language tag (e.g. `en-US`). Default: provider autodetect. */
  language?: string;
  /** Expected audio sample rate in Hz (default 16000). */
  sampleRate?: number;
  /** Model name (e.g. `whisper-1`, `base`, `small`, `medium`, `large`). */
  model?: string;
  /** Optional path to a whisper-cpp model file (system provider only). */
  modelPath?: string;
}

/**
 * A handle to an active recording session. Returned by
 * {@link STTEngine.startRecording}. The session streams partial
 * transcription via {@link onChunk} and resolves the final transcription
 * when {@link stop} is called.
 */
export interface RecordingSession {
  /** Unique session id. */
  id: string;
  /** Stop the recording and return the final transcription. */
  stop: () => Promise<TranscriptionResult>;
  /** Pause capture (no chunks emitted until {@link resume}). */
  pause: () => void;
  /** Resume capture after {@link pause}. */
  resume: () => void;
  /** Register a chunk listener (partial + final). */
  onChunk: (cb: (chunk: TranscriptionChunk) => void) => void;
}

// ─── Events ──────────────────────────────────────────────────────────────────

/**
 * Events emitted by {@link TTSEngine}. Subscribers attach via
 * `tts.on('speak:start', (payload) => ...)`.
 */
export interface TTSEngineEvents {
  /** Fired when `speak()` begins audio synthesis. */
  'speak:start': { text: string };
  /** Fired when `speak()` finishes producing audio. */
  'speak:complete': { output: AudioOutput };
  /** Fired when `speak()` errors. */
  'speak:error': { error: Error };
  /** Fired for each chunk produced by `stream()`. */
  'stream:chunk': { chunk: AudioChunk };
  /** Fired when `stream()` finishes. */
  'stream:complete': {};
}

/**
 * Events emitted by {@link STTEngine}.
 */
export interface STTEngineEvents {
  /** Fired when `transcribe()` begins. */
  'transcribe:start': { bytes: number };
  /** Fired when `transcribe()` finishes. */
  'transcribe:complete': { result: TranscriptionResult };
  /** Fired when `transcribe()` errors. */
  'transcribe:error': { error: Error };
  /** Fired when a recording session starts. */
  'recording:start': { sessionId: string };
  /** Fired when a recording session stops. */
  'recording:stop': { sessionId: string; result: TranscriptionResult };
  /** Fired for each transcription chunk (partial or final). */
  chunk: { chunk: TranscriptionChunk };
}

/**
 * Events emitted by {@link VoiceAssistant}.
 */
export interface VoiceAssistantEvents {
  /** Fired when the wake word is detected (or push-to-talk triggers). */
  'wake:detected': { timestamp: number };
  /** Fired after the user's speech has been transcribed. */
  'user:transcribed': { text: string };
  /** Fired when the LLM has begun producing a response. */
  'llm:responding': {};
  /** Fired when the LLM has finished producing a response. */
  'llm:complete': { response: string };
  /** Fired when TTS begins speaking the LLM response. */
  'tts:speaking': { text: string };
  /** Fired when TTS finishes speaking. */
  'tts:done': {};
  /** Fired on any error in the assistant loop. */
  error: { error: Error };
}
