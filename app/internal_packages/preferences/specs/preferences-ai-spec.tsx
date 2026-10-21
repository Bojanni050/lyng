import React from 'react';
import { render, fireEvent, cleanup, within } from '@testing-library/react';

import PreferencesAI from '../lib/tabs/preferences-ai';

// Trimmed DeepInfra response: one chat model with a price, one image model without one.
const modelsResponse = {
  data: [
    {
      id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
      metadata: {
        description: 'Llama 3.1 8B Instruct Turbo',
        context_length: 131072,
        max_tokens: 4028,
        pricing: { input_tokens: 0.02, output_tokens: 0.04 },
        tags: ['chat', 'vision'],
      },
    },
    {
      id: 'black-forest-labs/FLUX-1-schnell',
      metadata: {
        description: 'Fast image generation',
        tags: ['text-to-image'],
        pricing: { input_characters: 0.0001 },
      },
    },
  ],
};

// The spec runner replaces setTimeout/setInterval with a manual clock (time-override.ts), so
// waitFor never retries and real waits time out. Let the fetch/json/setState promise chain
// drain on the microtask queue, then nudge the clock for anything timer based.
async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
  advanceClock(1);
}

function buildConfig(initial: { [key: string]: string } = {}) {
  const values: { [key: string]: string } = { ...initial };
  return {
    values,
    get: (key: string) => values[key],
    set: jasmine.createSpy('config.set').andCallFake((key: string, value: string) => {
      values[key] = value;
    }),
    toggle: jasmine.createSpy('config.toggle'),
  };
}

describe('PreferencesAI', function () {
  const originalFetch = window.fetch;

  afterEach(function () {
    cleanup();
    window.fetch = originalFetch;
  });

  it('starts on the DeepInfra preset with its base URL filled in', function () {
    const config = buildConfig();
    const { container } = render(<PreferencesAI config={config as any} />);

    const provider = container.querySelector('#ai-provider') as HTMLSelectElement;
    const baseUrl = container.querySelector('#ai-base-url') as HTMLInputElement;

    expect(provider.value).toBe('deepinfra');
    expect(baseUrl.value).toBe('https://api.deepinfra.com/v1/openai');
    expect(provider.querySelectorAll('option').length).toBe(3); // two presets + custom
  });

  it('switches the base URL when another preset is picked', function () {
    const config = buildConfig();
    const { container } = render(<PreferencesAI config={config as any} />);

    fireEvent.change(container.querySelector('#ai-provider'), { target: { value: 'mistral' } });

    expect((container.querySelector('#ai-base-url') as HTMLInputElement).value).toBe(
      'https://api.mistral.ai/v1'
    );
    expect(config.set).toHaveBeenCalledWith('core.ai.provider', 'mistral');
    expect(config.set).toHaveBeenCalledWith('core.ai.baseUrl', 'https://api.mistral.ai/v1');
  });

  it('marks a hand-edited base URL as custom', function () {
    const config = buildConfig();
    const { container } = render(<PreferencesAI config={config as any} />);

    fireEvent.change(container.querySelector('#ai-base-url'), {
      target: { value: 'https://example.test/v1' },
    });

    expect((container.querySelector('#ai-provider') as HTMLSelectElement).value).toBe('custom');
  });

  it('fetches models, shows their price and capabilities, and saves the pick', async function () {
    let seenUrl = '';
    (window as any).fetch = (url: string) => {
      seenUrl = url;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(modelsResponse),
      });
    };

    const config = buildConfig();
    const { container, getByText, queryByText, queryAllByText } = render(
      <PreferencesAI config={config as any} />
    );

    fireEvent.click(
      within(container.querySelector('.ai-chat-section') as HTMLElement).getByText('Fetch models')
    );
    await settle();

    expect(seenUrl).toBe('https://api.deepinfra.com/v1/openai/models');
    expect(queryByText('2 models available, 1 of them chat models')).not.toBeNull();

    // Only chat models are listed until the user opts into the rest of the catalogue.
    fireEvent.click(container.querySelector('.ai-model-picker-button'));
    expect(queryByText('meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo')).not.toBeNull();
    expect(queryByText('black-forest-labs/FLUX-1-schnell')).toBeNull();
    expect(queryAllByText('$0.02 in · $0.04 out per 1M tokens').length).toBeGreaterThan(0);
    expect(queryByText('Vision')).not.toBeNull();
    expect(queryByText('131K context')).not.toBeNull();

    fireEvent.click(getByText('meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'));

    expect(config.set).toHaveBeenCalledWith(
      'core.ai.model',
      'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'
    );
  });

  it('reveals non-chat models when asked', async function () {
    (window as any).fetch = () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(modelsResponse) });

    const { container, queryByText } = render(<PreferencesAI config={buildConfig() as any} />);
    fireEvent.click(
      within(container.querySelector('.ai-chat-section') as HTMLElement).getByText('Fetch models')
    );
    await settle();

    // Rows only exist while the picker is open, so open it before checking the list.
    fireEvent.click(container.querySelector('.ai-model-picker-button'));
    expect(queryByText('black-forest-labs/FLUX-1-schnell')).toBeNull();

    const toggle = container.querySelector('.ai-toggle input') as HTMLInputElement;
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle);

    expect(queryByText('black-forest-labs/FLUX-1-schnell')).not.toBeNull();
    expect(queryByText('Image generation')).not.toBeNull();
  });

  it('tells the user when the provider rejects the key', async function () {
    (window as any).fetch = () =>
      Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });

    const { container, queryByText } = render(<PreferencesAI config={buildConfig() as any} />);
    fireEvent.click(
      within(container.querySelector('.ai-chat-section') as HTMLElement).getByText('Fetch models')
    );
    await settle();

    expect(queryByText(/rejected the API key/)).not.toBeNull();
  });

  it('restores the saved model and catalogue when a key is already configured', async function () {
    (window as any).fetch = () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(modelsResponse) });

    const config = buildConfig({
      'core.ai.baseUrl': 'https://api.deepinfra.com/v1/openai',
      'core.ai.apiKey': 'saved-key',
      'core.ai.model': 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    });
    const { container, queryAllByText } = render(<PreferencesAI config={config as any} />);
    await settle();

    // The saved configuration loads the catalogue without a click, so the price is visible.
    expect(queryAllByText('$0.02 in · $0.04 out per 1M tokens').length).toBeGreaterThan(0);
    expect(container.querySelector('.ai-model-picker-value').textContent).toBe(
      'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'
    );
  });
});
