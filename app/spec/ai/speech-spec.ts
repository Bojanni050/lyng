import {
  fetchTTSVoices,
  normalizeVoiceList,
  speechEndpoint,
  synthesizeSpeech,
  voicesEndpoint,
} from '../../src/ai/speech';
import { TTSConfig } from '../../src/ai/config';
import { AIProviderError } from '../../src/ai/provider-catalog';

const CONFIG: TTSConfig = {
  provider: 'mistral',
  baseUrl: 'https://api.mistral.ai/v1',
  apiKey: 'sk-tts',
  model: 'voxtral-mini-tts-2603',
  voice: 'voice_478',
};

type Call = { url: string; init: RequestInit };

function stubFetch(status: number, payload: any, contentType = 'application/json') {
  const calls: Call[] = [];
  (window as any).fetch = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
      },
      json: () => Promise.resolve(payload),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
  };
  return calls;
}

/** Await a call that must fail and hand back the error (this repo's typings have no `fail`). */
async function rejection(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the call to fail, but it resolved.');
}

describe('speech endpoints', function () {
  it('appends the speech and voices paths to the normalised base URL', () => {
    expect(speechEndpoint('https://api.mistral.ai/v1/')).toBe(
      'https://api.mistral.ai/v1/audio/speech'
    );
    expect(voicesEndpoint('api.mistral.ai/v1')).toBe('https://api.mistral.ai/v1/audio/voices');
  });
});

describe('normalizeVoiceList', function () {
  it('reads the documented voice list shape', () => {
    const voices = normalizeVoiceList({
      data: [
        { id: 'voice_478', name: 'Sarah', languages: ['en', 'fr'] },
        { voice_id: 'voice_12', name: 'Adam', languages: [{ language: 'en' }] },
      ],
    });

    expect(voices.length).toBe(2);
    expect(voices[0].id).toBe('voice_12');
    expect(voices[0].languages).toEqual(['en']);
    expect(voices[1].id).toBe('voice_478');
    expect(voices[1].languages).toEqual(['en', 'fr']);
  });

  it('accepts a bare array and drops rows without an id', () => {
    const voices = normalizeVoiceList([{ id: 'a', name: 'A' }, { name: 'No id' }, null]);
    expect(voices.map((voice) => voice.id)).toEqual(['a']);
  });
});

describe('fetchTTSVoices', function () {
  const originalFetch = window.fetch;

  afterEach(() => {
    (window as any).fetch = originalFetch;
  });

  it('sends the key and returns the voices', async () => {
    const calls = stubFetch(200, { data: [{ id: 'voice_478', name: 'Sarah' }] });

    const voices = await fetchTTSVoices({ baseUrl: CONFIG.baseUrl, apiKey: CONFIG.apiKey });

    expect(voices.length).toBe(1);
    expect(calls[0].url).toBe('https://api.mistral.ai/v1/audio/voices');
    expect((calls[0].init.headers as any).Authorization).toBe('Bearer sk-tts');
  });

  it('refuses to call without a key', async () => {
    const error = await rejection(() => fetchTTSVoices({ baseUrl: CONFIG.baseUrl, apiKey: '  ' }));
    expect(error.message).toContain('API key');
  });

  it('explains a wrong base URL', async () => {
    stubFetch(404, {});
    const error = await rejection(() =>
      fetchTTSVoices({ baseUrl: 'https://api.mistral.ai', apiKey: 'sk-tts' })
    );
    expect(error.message).toContain('https://api.mistral.ai/v1');
  });
});

describe('synthesizeSpeech', function () {
  const originalFetch = window.fetch;

  afterEach(() => {
    (window as any).fetch = originalFetch;
  });

  it('posts the model, text and voice, then decodes the base64 audio', async () => {
    const base64 = btoa('fake-mp3-bytes');
    const calls = stubFetch(200, { audio_data: base64 });

    const clip = await synthesizeSpeech({ config: CONFIG, text: '  Read this aloud.  ' });

    expect(clip.mimeType).toBe('audio/mpeg');
    expect(clip.blob.type).toBe('audio/mpeg');
    expect(clip.blob.size).toBe('fake-mp3-bytes'.length);
    expect(calls[0].url).toBe('https://api.mistral.ai/v1/audio/speech');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe(CONFIG.model);
    expect(body.input).toBe('Read this aloud.');
    expect(body.voice_id).toBe('voice_478');
    expect(body.response_format).toBe('mp3');
  });

  it('omits the voice so the provider can use its default', async () => {
    const calls = stubFetch(200, { audio_data: btoa('x') });

    await synthesizeSpeech({ config: { ...CONFIG, voice: '' }, text: 'Hello' });

    expect(JSON.parse(String(calls[0].init.body)).voice_id).toBeUndefined();
  });

  it('refuses when the provider is not configured', async () => {
    const error = await rejection(() =>
      synthesizeSpeech({ config: { ...CONFIG, apiKey: '' }, text: 'Hello' })
    );
    expect(error instanceof AIProviderError).toBe(true);
    expect(error.message).toContain('Preferences');
  });

  it('refuses empty text', async () => {
    const error = await rejection(() => synthesizeSpeech({ config: CONFIG, text: '   ' }));
    expect(error.message).toContain('no text to read aloud');
  });

  it('explains a model that does not do speech', async () => {
    stubFetch(422, {});
    const error = await rejection(() => synthesizeSpeech({ config: CONFIG, text: 'Hello' }));
    expect(error.message).toContain('text-to-speech model');
  });

  it('refuses a response with no audio', async () => {
    stubFetch(200, {});
    const error = await rejection(() => synthesizeSpeech({ config: CONFIG, text: 'Hello' }));
    expect(error.message).toContain('no audio');
  });
});
