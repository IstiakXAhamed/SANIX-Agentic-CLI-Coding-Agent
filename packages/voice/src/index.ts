/**
 * @file index.ts
 * @description Public entry point for `@sanix/voice`. Re-exports the TTS
 * engine, STT engine, VoiceAssistant, and all shared types.
 *
 * Importing paths:
 *   import { TTSEngine, STTEngine, VoiceAssistant } from '@sanix/voice';
 *   import type { AudioOutput, TranscriptionResult } from '@sanix/voice';
 *
 * @packageDocumentation
 */

export { TTSEngine } from './TTS.js';
export { STTEngine } from './STT.js';
export { VoiceAssistant, type VoiceAssistantOptions } from './VoiceAssistant.js';

export type {
  AudioFormat,
  AudioOutput,
  AudioChunk,
  Voice,
  TTSEngineOptions,
  TranscriptionSegment,
  TranscriptionWord,
  TranscriptionResult,
  TranscriptionChunk,
  STTEngineOptions,
  RecordingSession,
  TTSEngineEvents,
  STTEngineEvents,
  VoiceAssistantEvents,
} from './types.js';
