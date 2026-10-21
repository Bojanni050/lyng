/**
 * Where the AI features read their provider settings from.
 *
 * The preferences tab writes these keys and every feature reads them, so the key strings live in
 * one place: a typo here is a feature that silently reports "not configured" with no error.
 */

import { normalizeBaseUrl } from './provider-catalog';

export const AI_CONFIG_KEYS = {
  provider: 'core.ai.provider',
  baseUrl: 'core.ai.baseUrl',
  apiKey: 'core.ai.apiKey',
  model: 'core.ai.model',
};

export const TTS_CONFIG_KEYS = {
  provider: 'core.tts.provider',
  baseUrl: 'core.tts.baseUrl',
  apiKey: 'core.tts.apiKey',
  model: 'core.tts.model',
  voice: 'core.tts.voice',
};

/**
 * Mistral is the only text-to-speech provider for now. It is kept as its own provider row
 * rather than reusing the chat provider so a DeepInfra key (which cannot do TTS) does not
 * break read-aloud, and so the two can be moved to different services later.
 */
export const TTS_PROVIDERS = [
  { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1' },
];

export type ChatConfig = {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type TTSConfig = {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
};

export const STT_CONFIG_KEYS = {
  provider: 'core.stt.provider',
  baseUrl: 'core.stt.baseUrl',
  apiKey: 'core.stt.apiKey',
  model: 'core.stt.model',
  deviceId: 'core.stt.deviceId',
  micEnabled: 'core.stt.micEnabled',
  activationMode: 'core.stt.activationMode',
  hotkey: 'core.stt.hotkey',
};

/**
 * Speech to text gets its own provider row for the same reason text to speech has one: the chat
 * or read-aloud provider may not transcribe, and its model ids would only mislead this list.
 */
export const STT_PROVIDERS = [
  { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1' },
];

export const DEFAULT_STT_HOTKEY = 'ControlRight';

/** `hold` records while the key is down; `toggle` starts on the first press and stops on the next. */
export type STTActivationMode = 'hold' | 'toggle';

export type STTConfig = {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  deviceId: string;
  micEnabled: boolean;
  activationMode: STTActivationMode;
  hotkey: string;
};

function read(key: string): string {
  const value = AppEnv.config.get(key);
  return typeof value === 'string' ? value : '';
}

export function readChatConfig(): ChatConfig {
  return {
    provider: read(AI_CONFIG_KEYS.provider),
    baseUrl: normalizeBaseUrl(read(AI_CONFIG_KEYS.baseUrl)),
    apiKey: read(AI_CONFIG_KEYS.apiKey),
    model: read(AI_CONFIG_KEYS.model),
  };
}

export function readTTSConfig(): TTSConfig {
  return {
    provider: read(TTS_CONFIG_KEYS.provider) || TTS_PROVIDERS[0].id,
    baseUrl: normalizeBaseUrl(read(TTS_CONFIG_KEYS.baseUrl)) || TTS_PROVIDERS[0].baseUrl,
    apiKey: read(TTS_CONFIG_KEYS.apiKey),
    model: read(TTS_CONFIG_KEYS.model),
    voice: read(TTS_CONFIG_KEYS.voice),
  };
}

/** A model is part of "configured": without one there is nothing to call. */
export function isChatConfigured(config: ChatConfig = readChatConfig()): boolean {
  return Boolean(config.baseUrl && config.apiKey && config.model);
}

export function readSTTConfig(): STTConfig {
  const stored = AppEnv.config.get(STT_CONFIG_KEYS.activationMode);
  return {
    provider: read(STT_CONFIG_KEYS.provider) || STT_PROVIDERS[0].id,
    baseUrl: normalizeBaseUrl(read(STT_CONFIG_KEYS.baseUrl)) || STT_PROVIDERS[0].baseUrl,
    apiKey: read(STT_CONFIG_KEYS.apiKey),
    model: read(STT_CONFIG_KEYS.model),
    deviceId: read(STT_CONFIG_KEYS.deviceId),
    // The microphone is on unless the user turned it off; nothing records until they activate it.
    micEnabled: AppEnv.config.get(STT_CONFIG_KEYS.micEnabled) !== false,
    activationMode: stored === 'toggle' ? 'toggle' : 'hold',
    hotkey: read(STT_CONFIG_KEYS.hotkey) || DEFAULT_STT_HOTKEY,
  };
}

/** Dictation needs a key and a model; the device and hotkey have usable defaults. */
export function isSTTConfigured(config: STTConfig = readSTTConfig()): boolean {
  return Boolean(config.baseUrl && config.apiKey && config.model);
}

export function isTTSConfigured(config: TTSConfig = readTTSConfig()): boolean {
  return Boolean(config.baseUrl && config.apiKey && config.model);
}
