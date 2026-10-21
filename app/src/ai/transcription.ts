/**
 * Speech to text through an OpenAI-compatible audio transcription endpoint.
 *
 * The request is multipart/form-data (`file` plus `model`), which is also what Mistral accepts;
 * its response carries the transcript in `text`. Nothing here talks to a microphone — recording
 * belongs to the feature that starts dictation, so the settings tab and the dictation code share
 * one description of the request instead of two.
 */

import { AIProviderError } from './provider-catalog';
import { normalizeBaseUrl } from './provider-catalog';
import { STTConfig } from './config';

export function transcriptionsEndpoint(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/audio/transcriptions`;
}

function explainStatus(status: number, endpoint: string): string {
  if (status === 401 || status === 403) {
    return 'The provider rejected the API key for speech to text. Check the Mistral key in Preferences → AI.';
  }
  if (status === 404) {
    return `No transcription endpoint at ${endpoint}. The base URL should end at the API root, for example https://api.mistral.ai/v1.`;
  }
  if (status === 400 || status === 422) {
    return 'The provider rejected the recording. The selected model may not be a speech-to-text model.';
  }
  if (status === 429) {
    return 'The provider is rate limiting speech to text. Try again in a moment.';
  }
  if (status >= 500) {
    return 'The provider had a problem transcribing the audio. Try again in a moment.';
  }
  return `The provider answered with HTTP ${status}.`;
}

export type TranscribeInput = {
  config: STTConfig;
  /** The recorded audio. `webm/opus` is what MediaRecorder produces in Electron. */
  audio: Blob;
  filename?: string;
  language?: string;
  signal?: AbortSignal;
};

export type TranscriptionResult = {
  text: string;
  /** Present when the provider returns it; Mistral does for some models. */
  language?: string;
};

/** Sends the recording and returns the transcript. Throws `AIProviderError` with a readable message. */
export async function transcribeAudio(input: TranscribeInput): Promise<TranscriptionResult> {
  const { config, audio, filename = 'dictation.webm', language, signal } = input;

  if (!config.baseUrl || !config.apiKey) {
    return Promise.reject(
      new AIProviderError(
        'Speech to text is not configured. Add a Mistral API key in Preferences → AI.'
      )
    );
  }
  if (!config.model) {
    return Promise.reject(
      new AIProviderError('Choose a speech-to-text model in Preferences → AI first.')
    );
  }
  if (!audio || audio.size === 0) {
    return Promise.reject(new AIProviderError('There was no audio to transcribe.'));
  }

  const endpoint = transcriptionsEndpoint(config.baseUrl);
  const body = new FormData();
  body.append('model', config.model);
  body.append('file', audio, filename);
  if (language) body.append('language', language);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body,
      signal,
    });
  } catch (error) {
    if ((error as any)?.name === 'AbortError') throw error;
    throw new AIProviderError(
      `Could not reach ${endpoint}. Check the base URL and your connection.`
    );
  }

  if (!response.ok) {
    throw new AIProviderError(explainStatus(response.status, endpoint));
  }

  let payload: any;
  try {
    payload = await response.json();
  } catch (error) {
    throw new AIProviderError('The provider did not return a readable transcript.');
  }

  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    throw new AIProviderError('The provider returned an empty transcript.');
  }

  return {
    text,
    language: typeof payload?.language === 'string' ? payload.language : undefined,
  };
}
