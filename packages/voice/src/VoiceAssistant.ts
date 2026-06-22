/**
 * @file VoiceAssistant.ts
 * @description A hands-free voice conversation loop that wires STT + LLM +
 * TTS into a single EventEmitter3-driven assistant.
 *
 *   user speaks ─▶ STT.transcribe ─▶ chat() ─▶ LLM response ─▶ TTS.speak ─▶ user hears
 *
 * Supports an optional wake word (waits for the wake word to appear in a
 * transcription before triggering the full LLM round-trip) or push-to-talk
 * mode (manual trigger).
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import type { STTEngine } from './STT.js';
import type { TTSEngine } from './TTS.js';
import type { VoiceAssistantEvents } from './types.js';

/**
 * Constructor options for {@link VoiceAssistant}.
 */
export interface VoiceAssistantOptions {
  /** The speech-to-text engine (already configured). */
  stt: STTEngine;
  /** The text-to-speech engine (already configured). */
  tts: TTSEngine;
  /**
   * The chat function — given transcribed user text, returns the LLM's
   * response text. The caller wires this to whatever LLM provider /
   * AgentLoop they're using.
   */
  chat: (text: string) => Promise<string>;
  /**
   * Optional wake word (case-insensitive substring match). When set,
   * the assistant listens for the wake word in the STT output before
   * triggering the full LLM round-trip. When unset, the assistant runs
   * in push-to-talk mode (use {@link pushToTalk} to trigger a turn).
   */
  wakeWord?: string;
  /**
   * Optional interval (ms) between recording sessions in wake-word mode.
   * Default 250ms.
   */
  pollIntervalMs?: number;
}

/**
 * A hands-free voice assistant. Listens for a wake word (or push-to-talk),
 * transcribes the user's speech, sends the text to the configured chat
 * function, and speaks the response aloud.
 *
 * @example
 * ```ts
 * const va = new VoiceAssistant({
 *   stt: new STTEngine({ provider: 'system' }),
 *   tts: new TTSEngine({ provider: 'system' }),
 *   chat: async (text) => await llm.chat({ messages: [{ role: 'user', content: text }] }).then(r => r.content),
 *   wakeWord: 'sanix',
 * });
 * va.on('user:transcribed', ({ text }) => console.log('user:', text));
 * va.on('llm:complete', ({ response }) => console.log('assistant:', response));
 * await va.start();
 * ```
 */
export class VoiceAssistant extends EventEmitter<VoiceAssistantEvents> {
  private readonly stt: STTEngine;
  private readonly tts: TTSEngine;
  private readonly chat: (text: string) => Promise<string>;
  private readonly wakeWord?: string;
  private readonly pollIntervalMs: number;
  private running = false;
  private abortErr: Error | null = null;

  /**
   * @param opts - See {@link VoiceAssistantOptions}.
   */
  constructor(opts: VoiceAssistantOptions) {
    super();
    this.stt = opts.stt;
    this.tts = opts.tts;
    this.chat = opts.chat;
    this.wakeWord = opts.wakeWord?.toLowerCase();
    this.pollIntervalMs = opts.pollIntervalMs ?? 250;
  }

  /**
   * Begin the assistant loop.
   *
   * - If a wake word is configured, starts a continuous recording loop
   *   that waits for the wake word before triggering a full turn.
   * - If no wake word is set, the assistant runs in push-to-talk mode
   *   and `start()` simply prepares the loop; the caller must invoke
   *   {@link pushToTalk} to drive each turn.
   *
   * Resolves immediately (the loop runs in the background). Use
   * {@link stop} to terminate.
   */
  async start(): Promise<void> {
    this.running = true;
    this.abortErr = null;
    if (this.wakeWord) {
      void this.runWakeWordLoop();
    }
  }

  /**
   * Stop the assistant loop. Aborts any in-flight TTS, recording, or LLM
   * call. Safe to call multiple times.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.tts.stop();
  }

  /**
   * Manually trigger a single turn (push-to-talk mode, or as a
   * programmatic shortcut in wake-word mode). Starts a recording,
   * transcribes, calls the LLM, and speaks the response.
   */
  async pushToTalk(): Promise<void> {
    await this.runSingleTurn();
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  /**
   * The wake-word loop: continuously record short clips, transcribe, and
   * watch for the wake word. Once detected, trigger a single full turn.
   */
  private async runWakeWordLoop(): Promise<void> {
    while (this.running) {
      try {
        const session = this.stt.startRecording({ vad: true });
        const result = await session.stop();
        const text = result.text.toLowerCase();
        if (text.length > 0 && this.wakeWord && text.includes(this.wakeWord)) {
          this.emit('wake:detected', { timestamp: Date.now() });
          // Strip the wake word from the captured text so the LLM doesn't
          // see it.
          const stripped = result.text.replace(
            new RegExp(this.wakeWord, 'gi'),
            '',
          ).trim();
          if (stripped.length > 0) {
            await this.handleUserText(stripped);
          } else {
            // Wake word detected with nothing after it — record a fresh turn.
            await this.runSingleTurn();
          }
        }
      } catch (err) {
        this.abortErr = err instanceof Error ? err : new Error(String(err));
        this.emit('error', { error: this.abortErr });
      }
      if (this.running) {
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      }
    }
  }

  /**
   * Record a single user utterance and complete one full assistant turn.
   */
  private async runSingleTurn(): Promise<void> {
    try {
      const session = this.stt.startRecording({ vad: true });
      const result = await session.stop();
      const text = result.text.trim();
      if (text.length === 0) return;
      await this.handleUserText(text);
    } catch (err) {
      this.abortErr = err instanceof Error ? err : new Error(String(err));
      this.emit('error', { error: this.abortErr });
    }
  }

  /**
   * Handle one user utterance: emit, call LLM, speak response.
   */
  private async handleUserText(text: string): Promise<void> {
    this.emit('user:transcribed', { text });
    this.emit('llm:responding', {});
    let response: string;
    try {
      response = await this.chat(text);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', { error });
      return;
    }
    this.emit('llm:complete', { response });
    this.emit('tts:speaking', { text: response });
    try {
      await this.tts.speak(response, { interrupt: true });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', { error });
      return;
    }
    this.emit('tts:done', {});
  }
}
