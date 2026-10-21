import {
  MAX_EMAIL_CHARS,
  chatCompletionsEndpoint,
  completeChat,
  htmlToText,
  summarizeEmail,
  summarizePrompt,
  testChatProvider,
} from '../../src/ai/completion';
import { AIProviderError } from '../../src/ai/provider-catalog';
import { ChatConfig } from '../../src/ai/config';

const CONFIG: ChatConfig = {
  provider: 'deepinfra',
  baseUrl: 'https://api.deepinfra.com/v1/openai',
  apiKey: 'sk-test',
  model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
};

type Call = { url: string; init: RequestInit };

function stubFetch(status: number, payload: any) {
  const calls: Call[] = [];
  (window as any).fetch = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(payload),
    });
  };
  return calls;
}

function body(calls: Call[]) {
  return JSON.parse(String(calls[0].init.body));
}

/**
 * Await a call that must fail and hand back the error. Jasmine's `fail()` is not part of this
 * repo's typings, and throwing inside a `try` would be caught by the assertions themselves.
 */
async function rejection(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the call to fail, but it resolved.');
}

describe('completeChat', function () {
  const originalFetch = window.fetch;

  afterEach(() => {
    (window as any).fetch = originalFetch;
  });

  it('posts to the chat completions endpoint with the key and model', async () => {
    const calls = stubFetch(200, { choices: [{ message: { content: 'Hello there.' } }] });

    const reply = await completeChat({
      config: CONFIG,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(reply).toBe('Hello there.');
    expect(calls[0].url).toBe('https://api.deepinfra.com/v1/openai/chat/completions');
    expect((calls[0].init.headers as any).Authorization).toBe('Bearer sk-test');
    expect(body(calls).model).toBe(CONFIG.model);
    expect(body(calls).stream).toBe(false);
  });

  it('joins content parts returned as an array', async () => {
    stubFetch(200, {
      choices: [
        {
          message: {
            content: [
              { type: 'text', text: 'Part one. ' },
              { type: 'text', text: 'Part two.' },
            ],
          },
        },
      ],
    });

    const reply = await completeChat({
      config: CONFIG,
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(reply).toBe('Part one. Part two.');
  });

  it('explains a rejected key', async () => {
    stubFetch(401, {});
    const error = await rejection(() =>
      completeChat({ config: CONFIG, messages: [{ role: 'user', content: 'Hi' }] })
    );
    expect(error instanceof AIProviderError).toBe(true);
    expect(error.message).toContain('rejected the API key');
  });

  it('explains a base URL that is one segment too long', async () => {
    stubFetch(404, {});
    const error = await rejection(() =>
      completeChat({ config: CONFIG, messages: [{ role: 'user', content: 'Hi' }] })
    );
    expect(error.message).toContain('base URL');
  });

  it('refuses an empty reply', async () => {
    stubFetch(200, { choices: [{ message: { content: '   ' } }] });
    const error = await rejection(() =>
      completeChat({ config: CONFIG, messages: [{ role: 'user', content: 'Hi' }] })
    );
    expect(error.message).toContain('empty');
  });
});

describe('chatCompletionsEndpoint', function () {
  it('normalises the base URL before appending the path', () => {
    expect(chatCompletionsEndpoint('api.mistral.ai/v1/')).toBe(
      'https://api.mistral.ai/v1/chat/completions'
    );
  });
});

describe('htmlToText', function () {
  it('strips markup and collapses whitespace', () => {
    expect(htmlToText('<p>Hello <b>there</b></p>\n<p>Second   line</p>')).toBe(
      'Hello there Second line'
    );
  });

  it('drops script and style content', () => {
    expect(htmlToText('<style>p { color: red }</style><p>Only this</p>')).toBe('Only this');
  });
});

describe('summarizePrompt', function () {
  it('caps the body and keeps the subject', () => {
    const prompt = summarizePrompt({
      config: CONFIG,
      subject: 'Budget review',
      from: 'Ada',
      body: '<p>' + 'word '.repeat(MAX_EMAIL_CHARS) + '</p>',
      plaintext: false,
    });

    expect(prompt[0].role).toBe('system');
    expect(prompt[1].content).toContain('Budget review');
    expect(prompt[1].content).toContain('Ada');
    expect(prompt[1].content.length).toBeLessThan(MAX_EMAIL_CHARS + 400);
  });

  it('refuses a message with no text', async () => {
    const error = await rejection(async () =>
      summarizePrompt({ config: CONFIG, subject: 'Empty', body: '<div></div>' })
    );
    expect(error.message).toContain('no text to summarize');
  });
});

describe('summarizeEmail', function () {
  const originalFetch = window.fetch;

  afterEach(() => {
    (window as any).fetch = originalFetch;
  });

  it('asks for a short summary with a low temperature', async () => {
    const calls = stubFetch(200, {
      choices: [{ message: { content: 'Ada needs the budget by Friday.' } }],
    });

    const summary = await summarizeEmail({
      config: CONFIG,
      subject: 'Budget',
      body: '<p>Can you send the budget by Friday?</p>',
      plaintext: false,
    });

    expect(summary).toBe('Ada needs the budget by Friday.');
    expect(body(calls).max_tokens).toBe(300);
    expect(body(calls).temperature).toBe(0.1);
  });
});

describe('testChatProvider', function () {
  const originalFetch = window.fetch;

  afterEach(() => {
    (window as any).fetch = originalFetch;
  });

  it('returns the reply and a latency', async () => {
    stubFetch(200, { choices: [{ message: { content: 'pong' } }] });

    const result = await testChatProvider(CONFIG);

    expect(result.reply).toBe('pong');
    expect(typeof result.elapsedMs).toBe('number');
  });
});
