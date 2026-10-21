import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react';

import PreferencesSTT from '../lib/tabs/preferences-stt';

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
  advanceClock(1);
}

function buildConfig(initial: { [key: string]: string | boolean } = {}) {
  const values: { [key: string]: string | boolean } = { ...initial };
  return {
    values,
    get: (key: string) => values[key],
    set: jasmine.createSpy('config.set').andCallFake((key: string, value: string | boolean) => {
      values[key] = value;
    }),
    toggle: jasmine.createSpy('config.toggle'),
  };
}

const STT_MODELS = {
  data: [
    { id: 'voxtral-mini-transcribe-3', name: 'Voxtral Mini Transcribe' },
    { id: 'voxtral-mini-transcribe-latest', name: 'Voxtral Mini Transcribe (latest)' },
    { id: 'mistral-large-latest', name: 'Mistral Large', capabilities: { completion_chat: true } },
  ],
};

const DEVICES = [
  { kind: 'audioinput', deviceId: 'mic-a', label: 'Headset Microphone' },
  { kind: 'audioinput', deviceId: 'mic-b', label: '' },
  { kind: 'audiooutput', deviceId: 'speaker', label: 'Speakers' },
];

function stubDevices(devices: any[] = DEVICES) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { enumerateDevices: () => Promise.resolve(devices) },
  });
}

describe('PreferencesSTT', function () {
  let originalFetch: any;
  let originalMediaDevices: any;

  beforeEach(function () {
    originalFetch = (window as any).fetch;
    originalMediaDevices = (navigator as any).mediaDevices;
    stubDevices();
  });

  afterEach(function () {
    cleanup();
    (window as any).fetch = originalFetch;
    if (originalMediaDevices === undefined) {
      delete (navigator as any).mediaDevices;
    } else {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: originalMediaDevices,
      });
    }
  });

  it('starts on Mistral with Right Ctrl, hold to talk, and the microphone on', function () {
    const config = buildConfig();
    const { container } = render(<PreferencesSTT config={config as any} />);

    expect((container.querySelector('#stt-base-url') as HTMLInputElement).value).toBe(
      'https://api.mistral.ai/v1'
    );
    expect((container.querySelector('#stt-hotkey') as HTMLInputElement).value).toBe('Right Ctrl');
    expect((container.querySelector('#stt-activation') as HTMLSelectElement).value).toBe('hold');
    expect((container.querySelector('.ai-toggle input') as HTMLInputElement).checked).toBe(true);
  });

  it('stores the code of the key the user presses', function () {
    const config = buildConfig();
    const { container } = render(<PreferencesSTT config={config as any} />);
    const hotkey = container.querySelector('#stt-hotkey') as HTMLInputElement;

    fireEvent.keyDown(hotkey, { code: 'F9', key: 'F9' });

    expect(config.set).toHaveBeenCalledWith('core.stt.hotkey', 'F9');
    expect(hotkey.value).toBe('F9');
  });

  it('keeps the current key when the user presses Escape', function () {
    const config = buildConfig({ 'core.stt.hotkey': 'ControlRight' });
    const { container } = render(<PreferencesSTT config={config as any} />);
    const hotkey = container.querySelector('#stt-hotkey') as HTMLInputElement;

    fireEvent.keyDown(hotkey, { code: 'Escape', key: 'Escape' });

    expect(config.set).not.toHaveBeenCalledWith('core.stt.hotkey', 'Escape');
    expect(hotkey.value).toBe('Right Ctrl');
  });

  it('resets the key to Right Ctrl', function () {
    const config = buildConfig({ 'core.stt.hotkey': 'KeyJ' });
    const { container } = render(<PreferencesSTT config={config as any} />);
    const reset = Array.from(container.querySelectorAll('.ai-key-row button')).pop() as HTMLElement;

    fireEvent.click(reset);

    expect(config.set).toHaveBeenCalledWith('core.stt.hotkey', 'ControlRight');
  });

  it('lists the microphones and persists the chosen one', async function () {
    const config = buildConfig();
    const { container } = render(<PreferencesSTT config={config as any} />);
    await settle();

    const select = container.querySelector('#stt-device') as HTMLSelectElement;
    expect(select.options.length).toBe(3); // system default plus the two inputs
    expect(select.options[1].textContent).toBe('Headset Microphone');
    expect(select.options[2].textContent).toBe('Microphone 2');

    fireEvent.change(select, { target: { value: 'mic-b' } });
    expect(config.set).toHaveBeenCalledWith('core.stt.deviceId', 'mic-b');
  });

  it('turns the microphone off and on again', function () {
    const config = buildConfig();
    const { container } = render(<PreferencesSTT config={config as any} />);
    const toggle = container.querySelector('.ai-toggle input') as HTMLInputElement;

    fireEvent.click(toggle);
    expect(config.set).toHaveBeenCalledWith('core.stt.micEnabled', false);

    fireEvent.click(toggle);
    expect(config.set).toHaveBeenCalledWith('core.stt.micEnabled', true);
  });

  it('switches between hold and toggle activation', function () {
    const config = buildConfig();
    const { container } = render(<PreferencesSTT config={config as any} />);

    fireEvent.change(container.querySelector('#stt-activation'), { target: { value: 'toggle' } });

    expect(config.set).toHaveBeenCalledWith('core.stt.activationMode', 'toggle');
  });

  it('narrows the fetched model list to transcription models', async function () {
    (window as any).fetch = () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(STT_MODELS) });

    const config = buildConfig();
    const { container } = render(<PreferencesSTT config={config as any} />);
    fireEvent.click(container.querySelector('.ai-fetch-row button') as HTMLElement);
    await settle();

    expect(container.textContent).toContain('2 speech models available');
    fireEvent.click(container.querySelector('.ai-model-picker-button') as HTMLElement);
    expect(container.textContent).toContain('Voxtral Mini Transcribe');
    expect(container.textContent).not.toContain('Mistral Large');
  });

  it('reports when there is no microphone', async function () {
    stubDevices([]);
    const config = buildConfig();
    const { container } = render(<PreferencesSTT config={config as any} />);
    await settle();

    expect(container.textContent).toContain('No microphone found');
  });
});
