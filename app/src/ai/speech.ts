/**
 * Text-to-speech through Mistral's audio API.
 *
 * Mistral answers `POST /audio/speech` with JSON carrying base64 audio in `audio_data`, not with
 * an audio body, so the response has to be decoded before it can be played. Voices are listed
 * separately, and `voice_id` is optional on this side: the provider picks a default voice when
 * none is chosen.
 */

import { TTSConfig } from './config';
import { AIProviderError, normalizeBaseUrl } from './provider-catalog';

export type TTSVoice = {
  id: string;
  name?: string;
  description?: string;
  languages: string[];
};

export function speechEndpoint(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new AIProviderError('Enter a base URL first.');
  return `${base}/audio/speech`;
}

export function voicesEndpoint(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new AIProviderError('Enter a base URL first.');
  return `${base}/audio/voices`;
}

function explainAudioStatus(status: number, endpoint: string): string {
  if (status === 401 || status === 403) {
    return 'Mistral rejected the API key. Check the key in Preferences › AI.';
  }
  if (status === 404) {
    return `No audio endpoint at ${endpoint}. The base URL should be https://api.mistral.ai/v1.`;
  }
  if (status === 400 || status === 422) {
    return 'Mistral rejected the request. The selected model may not be a text-to-speech model.';
  }
  if (status === 429) {
    return 'Mistral is rate limiting this key. Try again in a moment.';
  }
  if (status >= 500) {
    return `Mistral returned a server error (HTTP ${status}). Try again later.`;
  }
  return `Mistral returned HTTP ${status}.`;
}

function languageList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry.language === 'string') return entry.language;
      if (entry && typeof entry.code === 'string') return entry.code;
      return null;
    })
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeVoice(item: unknown): TTSVoice | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, any>;
  const id = record.id || record.voice_id || record.voiceId;
  if (typeof id !== 'string' || !id) return null;
  return {
    id,
    name: typeof record.name === 'string' ? record.name : undefined,
    description: typeof record.description === 'string' ? record.description : undefined,
    languages: languageList(record.languages || record.language),
  };
}

export function normalizeVoiceList(payload: unknown): TTSVoice[] {
  const container = payload as any;
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(container?.data)
      ? container.data
      : Array.isArray(container?.voices)
        ? container.voices
        : [];
  const voices = rows
    .map(normalizeVoice)
    .filter((voice: TTSVoice | null): voice is TTSVoice => Boolean(voice));
  return voices.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}

export async function fetchTTSVoices(options: {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<TTSVoice[]> {
  if (!options.apiKey.trim()) {
    throw new AIProviderError('Add the Mistral API key first.');
  }
  const endpoint = voicesEndpoint(options.baseUrl);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${options.apiKey.trim()}` },
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new AIProviderError(`Could not reach ${endpoint}. Check your network connection.`);
  }

  if (!response.ok) {
    throw new AIProviderError(explainAudioStatus(response.status, endpoint), response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AIProviderError('Mistral returned a voice list that is not JSON.');
  }
  return normalizeVoiceList(payload);
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export type SpeechClip = { blob: Blob; mimeType: string };

/**
 * Turn text into playable audio. `voiceId` is optional; when empty Mistral uses its default.
 */
export async function synthesizeSpeech(options: {
  config: TTSConfig;
  text: string;
  signal?: AbortSignal;
}): Promise<SpeechClip> {
  const { config } = options;
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new AIProviderError(
      'No text-to-speech provider is configured. Add one in Preferences › AI.'
    );
  }
  const text = options.text.trim();
  if (!text) throw new AIProviderError('There is no text to read aloud.');
  const endpoint = speechEndpoint(config.baseUrl);

  const body: Record<string, unknown> = {
    model: config.model,
    input: text,
    response_format: 'mp3',
  };
  if (config.voice) body.voice_id = config.voice;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new AIProviderError(`Could not reach ${endpoint}. Check your network connection.`);
  }

  if (!response.ok) {
    throw new AIProviderError(explainAudioStatus(response.status, endpoint), response.status);
  }

  // Documented shape is JSON with base64 audio. Some gateways answer with the audio bytes
  // instead, so both are accepted rather than failing on a working provider.
  if ((response.headers.get('content-type') || '').includes('application/json')) {
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new AIProviderError('Mistral returned audio metadata that is not JSON.');
    }
    const audio = payload?.audio_data || payload?.audio;
    if (typeof audio !== 'string' || !audio) {
      throw new AIProviderError('Mistral returned no audio for this request.');
    }
    return {
      blob: new Blob([decodeBase64(audio)], { type: 'audio/mpeg' }),
      mimeType: 'audio/mpeg',
    };
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new AIProviderError('Mistral returned empty audio for this request.');
  }
  const mimeType = response.headers.get('content-type') || 'audio/mpeg';
  return { blob: new Blob([buffer], { type: mimeType }), mimeType };
}
