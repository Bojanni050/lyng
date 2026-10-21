import { transcribeAudio, transcriptionsEndpoint } from '../../src/ai/transcription';
import { STTConfig } from '../../src/ai/config';

function config(overrides: Partial<STTConfig> = {}): STTConfig {
  return {
    provider: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKey: 'ms-test',
    model: 'voxtral-mini-transcribe-3',
    deviceId: '',
    micEnabled: true,
    activationMode: 'hold',
    hotkey: 'ControlRight',
    ...overrides,
  };
}

/** Resolves with the rejection instead of failing the spec, so the message can be asserted. */
async function rejection(promise: Promise<unknown>): Promise<Error | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error as Error;
  }
}

describe('transcribeAudio', function () {
  let originalFetch: any;
  let calls: Array<{ url: string; init: RequestInit }>;

  beforeEach(function () {
    originalFetch = (window as any).fetch;
    calls = [];
  });

  afterEach(function () {
    (window as any).fetch = originalFetch;
  });

  function stubResponse(status: number, payload: any) {
    (window as any).fetch = (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(payload),
      });
    };
  }

  it('posts the recording as multipart form data to the transcription endpoint', async function () {
    stubResponse(200, { text: 'Hallo wereld' });

    const result = await transcribeAudio({
      config: config(),
      audio: new Blob(['audio-bytes'], { type: 'audio/webm' }),
      filename: 'note.webm',
    });

    expect(result.text).toBe('Hallo wereld');
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://api.mistral.ai/v1/audio/transcriptions');
    expect((calls[0].init.headers as any).Authorization).toBe('Bearer ms-test');

    const body = calls[0].init.body as FormData;
    expect(body.get('model')).toBe('voxtral-mini-transcribe-3');
    expect((body.get('file') as File).name).toBe('note.webm');
  });

  it('adds the language when one is given', async function () {
    stubResponse(200, { text: 'Hallo' });

    await transcribeAudio({
      config: config(),
      audio: new Blob(['audio-bytes']),
      language: 'nl',
    });

    expect((calls[0].init.body as FormData).get('language')).toBe('nl');
  });

  it('reports a rejected key without pretending the transcript is empty', async function () {
    stubResponse(401, {});

    const error = await rejection(
      transcribeAudio({ config: config(), audio: new Blob(['audio-bytes']) })
    );

    expect(error.message).toContain('API key');
  });

  it('points at the base URL when the endpoint is missing', async function () {
    stubResponse(404, {});

    const error = await rejection(
      transcribeAudio({ config: config(), audio: new Blob(['audio-bytes']) })
    );

    expect(error.message).toContain('https://api.mistral.ai/v1');
  });

  it('refuses to call the provider without a model', async function () {
    const error = await rejection(
      transcribeAudio({ config: config({ model: '' }), audio: new Blob(['x']) })
    );

    expect(error.message).toContain('Preferences');
    expect(calls.length).toBe(0);
  });

  it('refuses to send an empty recording', async function () {
    const error = await rejection(transcribeAudio({ config: config(), audio: new Blob([]) }));

    expect(error.message).toContain('no audio');
    expect(calls.length).toBe(0);
  });

  it('reports an empty transcript', async function () {
    stubResponse(200, { text: '   ' });

    const error = await rejection(
      transcribeAudio({ config: config(), audio: new Blob(['audio-bytes']) })
    );

    expect(error.message).toContain('empty transcript');
  });
});

describe('transcriptionsEndpoint', function () {
  it('normalises the base URL', function () {
    expect(transcriptionsEndpoint('https://api.mistral.ai/v1/')).toBe(
      'https://api.mistral.ai/v1/audio/transcriptions'
    );
  });
});
