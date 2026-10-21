import {
  describePricing,
  fetchProviderModels,
  formatContextLength,
  formatCostPerMillion,
  modelsEndpoint,
  normalizeBaseUrl,
  normalizeModel,
  normalizeModelList,
  presetFor,
  sortModels,
} from '../../src/ai/provider-catalog';

// Shapes below are trimmed copies of real responses: DeepInfra publishes descriptions and
// prices inside `metadata`, Mistral publishes capability flags and no prices at all.
const deepInfraModel = {
  id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
  object: 'model',
  owned_by: 'deepinfra',
  metadata: {
    description: 'Llama 3.1 8B Instruct Turbo',
    context_length: 131072,
    max_tokens: 4028,
    pricing: { input_tokens: 0.02, output_tokens: 0.04, cache_read_tokens: 0.02 },
    tags: ['chat', 'vision', 'reasoning'],
  },
};

const deepInfraImageModel = {
  id: 'black-forest-labs/FLUX-1-schnell',
  metadata: {
    description: 'Fast image generation',
    tags: ['text-to-image'],
    pricing: { input_characters: 0.0001 },
    default_width: 1024,
  },
};

const mistralModel = {
  id: 'mistral-large-latest',
  name: 'Mistral Large',
  description: 'Flagship model',
  max_context_length: 131072,
  capabilities: { completion_chat: true, function_calling: true, vision: false },
  aliases: ['mistral-large-2411'],
  deprecated: false,
};

const mistralEmbeddingModel = {
  id: 'mistral-embed',
  name: 'Mistral Embed',
  max_context_length: 8192,
  capabilities: { completion_chat: false },
};

describe('AI provider catalogue', function () {
  describe('base URLs', function () {
    it('trims, adds a scheme and drops trailing slashes', function () {
      expect(normalizeBaseUrl('  api.deepinfra.com/v1/openai/  ')).toBe(
        'https://api.deepinfra.com/v1/openai'
      );
      expect(normalizeBaseUrl('https://api.mistral.ai/v1//')).toBe('https://api.mistral.ai/v1');
      expect(normalizeBaseUrl('')).toBe('');
    });

    it('appends /models to the API root', function () {
      expect(modelsEndpoint('https://api.mistral.ai/v1')).toBe('https://api.mistral.ai/v1/models');
    });

    it('recognises the built-in presets, including trailing slashes', function () {
      expect(presetFor('https://api.deepinfra.com/v1/openai')?.id).toBe('deepinfra');
      expect(presetFor('https://api.mistral.ai/v1/')?.id).toBe('mistral');
      expect(presetFor('https://example.test/v1')).toBeUndefined();
    });
  });

  describe('DeepInfra models', function () {
    it('reads description, context window, price and capability tags', function () {
      const model = normalizeModel(deepInfraModel);
      expect(model.id).toBe('meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo');
      expect(model.description).toBe('Llama 3.1 8B Instruct Turbo');
      expect(model.contextLength).toBe(131072);
      expect(model.maxOutputTokens).toBe(4028);
      expect(model.inputCostPerMillion).toBe(0.02);
      expect(model.outputCostPerMillion).toBe(0.04);
      expect(model.capabilities).toEqual(['Chat', 'Vision', 'Reasoning']);
      expect(model.chatCapable).toBe(true);
    });

    it('does not treat character pricing as a token price', function () {
      const model = normalizeModel(deepInfraImageModel);
      expect(model.inputCostPerMillion).toBeUndefined();
      expect(model.outputCostPerMillion).toBeUndefined();
      expect(describePricing(model)).toBeNull();
      expect(model.chatCapable).toBe(false);
      expect(model.capabilities).toEqual(['Image generation']);
    });

    it('accepts metadata delivered as a JSON string', function () {
      const model = normalizeModel({
        id: 'string-metadata',
        metadata: JSON.stringify(deepInfraModel.metadata),
      });
      expect(model.inputCostPerMillion).toBe(0.02);
      expect(model.description).toBe('Llama 3.1 8B Instruct Turbo');
    });
  });

  describe('Mistral models', function () {
    it('maps capability flags and leaves pricing empty', function () {
      const model = normalizeModel(mistralModel);
      expect(model.name).toBe('Mistral Large');
      expect(model.capabilities).toEqual(['Chat', 'Tool calling']);
      expect(model.contextLength).toBe(131072);
      expect(model.inputCostPerMillion).toBeUndefined();
      expect(describePricing(model)).toBeNull();
      expect(model.chatCapable).toBe(true);
    });

    it('treats embedding-only models as non-chat', function () {
      const model = normalizeModel(mistralEmbeddingModel);
      expect(model.chatCapable).toBe(false);
      expect(model.capabilities).toEqual([]);
    });
  });

  describe('formatting', function () {
    it('formats prices without inventing precision', function () {
      expect(formatCostPerMillion(0.02)).toBe('$0.02');
      expect(formatCostPerMillion(0.005)).toBe('$0.005');
      expect(formatCostPerMillion(1.3)).toBe('$1.30');
      expect(formatCostPerMillion(0)).toBe('free');
      expect(formatCostPerMillion(undefined)).toBeNull();
    });

    it('describes input and output prices together', function () {
      const model = normalizeModel(deepInfraModel);
      expect(describePricing(model)).toContain('$0.02 in');
      expect(describePricing(model)).toContain('$0.04 out');
    });

    it('formats context windows', function () {
      expect(formatContextLength(131072)).toBe('131K context');
      expect(formatContextLength(1000000)).toBe('1M context');
      expect(formatContextLength(undefined)).toBeNull();
    });
  });

  describe('lists', function () {
    it('accepts data, models and bare arrays and skips unusable rows', function () {
      expect(normalizeModelList({ data: [deepInfraModel] }).length).toBe(1);
      expect(normalizeModelList({ models: [mistralModel] }).length).toBe(1);
      expect(normalizeModelList([mistralModel]).length).toBe(1);
      expect(normalizeModelList({ data: [{}, null, { id: '' }, mistralModel] }).length).toBe(1);
      expect(normalizeModelList({ nope: true }).length).toBe(0);
    });

    it('shows chat models first, then non-deprecated, then alphabetical', function () {
      const chat = normalizeModel(mistralModel);
      const embedding = normalizeModel(mistralEmbeddingModel);
      const deprecatedChat = normalizeModel({
        ...mistralModel,
        id: 'old-model',
        name: 'Aardvark',
        deprecated: true,
      });
      const sorted = sortModels([embedding, deprecatedChat, chat]).map((model) => model.name);
      expect(sorted).toEqual(['Mistral Large', 'Aardvark', 'Mistral Embed']);
    });
  });

  describe('fetching', function () {
    const originalFetch = window.fetch;

    afterEach(function () {
      window.fetch = originalFetch;
    });

    it('sends the key and returns normalised models', async function () {
      let seenUrl = '';
      let seenAuth: string | undefined;
      (window as any).fetch = (url: string, init: any) => {
        seenUrl = url;
        seenAuth = init.headers.Authorization;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: [deepInfraModel, deepInfraImageModel] }),
        });
      };

      const models = await fetchProviderModels({
        baseUrl: 'https://api.deepinfra.com/v1/openai',
        apiKey: 'secret-key',
      });
      expect(seenUrl).toBe('https://api.deepinfra.com/v1/openai/models');
      expect(seenAuth).toBe('Bearer secret-key');
      expect(models.length).toBe(2);
      expect(models[0].chatCapable).toBe(true);
    });

    it('explains a rejected key instead of surfacing a bare status', async function () {
      (window as any).fetch = () =>
        Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });

      let message = '';
      try {
        await fetchProviderModels({ baseUrl: 'https://api.mistral.ai/v1', apiKey: 'wrong' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('rejected the API key');
    });

    it('reports an unreachable host as a base-URL problem', async function () {
      (window as any).fetch = () => Promise.reject(new TypeError('Failed to fetch'));

      let message = '';
      try {
        await fetchProviderModels({ baseUrl: 'https://nope.example.test/v1', apiKey: 'k' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('Could not reach');
      expect(message).toContain('https://nope.example.test/v1/models');
    });
  });
});
