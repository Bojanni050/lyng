import React from 'react';
import { localized } from 'mailspring-exports';
import {
  fetchProviderModels,
  AIProviderError,
  AIModelInfo,
} from '../../../../src/ai/provider-catalog';
import {
  STT_PROVIDERS,
  STT_CONFIG_KEYS,
  DEFAULT_STT_HOTKEY,
  readSTTConfig,
  STTActivationMode,
  STTConfig,
} from '../../../../src/ai/config';
import { formatHotkey } from '../../../../src/ai/hotkey';
import { readSecret, storeSecret } from '../../../../src/ai/secrets';
import { ConfigLike } from '../types';
import ModelPicker from './model-picker';

type AudioInput = { deviceId: string; label: string };

type PreferencesSTTState = {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  deviceId: string;
  micEnabled: boolean;
  activationMode: STTActivationMode;
  hotkey: string;
  models: AIModelInfo[] | null;
  devices: AudioInput[] | null;
  loadingModels: boolean;
  error: string | null;
  status: string | null;
  revealKey: boolean;
  capturing: boolean;
};

/**
 * Dictation settings: which model transcribes, which microphone is used, and how the microphone
 * is activated.
 *
 * The hotkey is stored as a `KeyboardEvent.code`, not a label, so it keeps pointing at the same
 * physical key when the user changes keyboard layout. Right Ctrl is the default because it is
 * unused in the compose window's own shortcuts.
 */
class PreferencesSTT extends React.Component<{ config: ConfigLike }, PreferencesSTTState> {
  static displayName = 'PreferencesSTT';

  private _modelsController: AbortController | null = null;

  constructor(props: { config: ConfigLike }) {
    super(props);
    const saved = readSTTConfigFrom(props.config);
    this.state = {
      ...saved,
      models: null,
      devices: null,
      loadingModels: false,
      error: null,
      status: null,
      revealKey: false,
      capturing: false,
    };
  }

  componentDidMount() {
    if (this.state.apiKey) this._fetchModels();
    this._loadDevices();
  }

  componentWillUnmount() {
    this._modelsController?.abort();
  }

  async _loadDevices() {
    const mediaDevices = (navigator as any).mediaDevices;
    if (!mediaDevices || typeof mediaDevices.enumerateDevices !== 'function') {
      this.setState({ devices: [] });
      return;
    }
    try {
      const found = await mediaDevices.enumerateDevices();
      const inputs: AudioInput[] = found
        .filter((device: MediaDeviceInfo) => device.kind === 'audioinput')
        .map((device: MediaDeviceInfo, index: number) => ({
          // Labels stay empty until the app has microphone permission; number them so the
          // dropdown is still usable instead of showing a list of blank rows.
          label: device.label || localized('Microphone %@', index + 1),
          deviceId: device.deviceId,
        }));
      this.setState({ devices: inputs });
    } catch (error) {
      this.setState({ devices: [] });
    }
  }

  _config(): STTConfig {
    return {
      provider: this.state.provider,
      baseUrl: this.state.baseUrl,
      apiKey: this.state.apiKey,
      model: this.state.model,
      deviceId: this.state.deviceId,
      micEnabled: this.state.micEnabled,
      activationMode: this.state.activationMode,
      hotkey: this.state.hotkey,
    };
  }

  _setConfig(key: string, value: string | boolean) {
    this.props.config.set(key, value);
  }

  _onApiKeyChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    void storeSecret('stt', event.target.value);
    this.setState({ apiKey: event.target.value, error: null, status: null });
  };

  _onBaseUrlChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    this._setConfig(STT_CONFIG_KEYS.baseUrl, event.target.value);
    this.setState({ baseUrl: event.target.value, models: null, error: null, status: null });
  };

  _onModelChange = (model: string) => {
    this._setConfig(STT_CONFIG_KEYS.model, model);
    this.setState({ model, error: null, status: null });
  };

  _onDeviceChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    this._setConfig(STT_CONFIG_KEYS.deviceId, event.target.value);
    this.setState({ deviceId: event.target.value, status: null });
  };

  _onMicEnabledChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const micEnabled = event.target.checked;
    this._setConfig(STT_CONFIG_KEYS.micEnabled, micEnabled);
    this.setState({ micEnabled, status: null });
  };

  _onActivationChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const activationMode = event.target.value as STTActivationMode;
    this._setConfig(STT_CONFIG_KEYS.activationMode, activationMode);
    this.setState({ activationMode, status: null });
  };

  _onHotkeyKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // Every key is captured here: the field exists to record a choice, not to type into.
    event.preventDefault();
    if (event.code === 'Escape') {
      this.setState({ capturing: false });
      return;
    }
    if (!event.code) return;
    this._setConfig(STT_CONFIG_KEYS.hotkey, event.code);
    this.setState({ hotkey: event.code, capturing: false, status: null });
  };

  _onResetHotkey = () => {
    this._setConfig(STT_CONFIG_KEYS.hotkey, DEFAULT_STT_HOTKEY);
    this.setState({ hotkey: DEFAULT_STT_HOTKEY, status: null });
  };

  /** Mistral does not flag which models transcribe, so the list narrows by name. */
  _visibleModels(): AIModelInfo[] {
    const models = this.state.models || [];
    const speech = models.filter((model) => /transcribe|stt|whisper|voxtral/i.test(model.id));
    return speech.length > 0 ? speech : models;
  }

  async _fetchModels() {
    if (this.state.loadingModels) return;
    this._modelsController?.abort();
    const controller = new AbortController();
    this._modelsController = controller;
    this.setState({ loadingModels: true, error: null });

    try {
      const models = await fetchProviderModels({
        baseUrl: this.state.baseUrl,
        apiKey: this.state.apiKey,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const speech = models.filter((model) => /transcribe|stt|whisper|voxtral/i.test(model.id));
      this.setState({
        models,
        loadingModels: false,
        status: localized('%1$@ speech models available', speech.length || models.length),
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.setState({
        loadingModels: false,
        error:
          error instanceof AIProviderError
            ? error.message
            : localized('Something went wrong while fetching the speech-to-text models.'),
      });
    }
  }

  render() {
    const models = this.state.models;
    const visible = this._visibleModels();
    const provider = STT_PROVIDERS.find((item) => item.id === this.state.provider);

    return (
      <section className="preferences-stt">
        <h6>{localized('Dictation (speech to text)')}</h6>
        <p>
          {localized(
            'Transcribes what you say into text. This is a separate provider from the chat and read-aloud providers.'
          )}
        </p>

        <div className="item ai-field">
          <label htmlFor="stt-provider">{localized('Provider')}</label>
          <select id="stt-provider" value={this.state.provider} disabled>
            {STT_PROVIDERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <div className="ai-hint">
            {localized('Mistral is currently the only speech-to-text provider.')}
          </div>
        </div>

        <div className="item ai-field">
          <label htmlFor="stt-base-url">{localized('Base URL')}</label>
          <input
            id="stt-base-url"
            type="text"
            spellCheck={false}
            value={this.state.baseUrl}
            placeholder={provider?.baseUrl}
            onChange={this._onBaseUrlChange}
          />
        </div>

        <div className="item ai-field">
          <label htmlFor="stt-api-key">{localized('Mistral API key')}</label>
          <div className="ai-key-row">
            <input
              id="stt-api-key"
              type={this.state.revealKey ? 'text' : 'password'}
              spellCheck={false}
              autoComplete="off"
              value={this.state.apiKey}
              placeholder={localized('ms-…')}
              onChange={this._onApiKeyChange}
            />
            <button
              type="button"
              className="btn btn-small"
              onClick={() => this.setState({ revealKey: !this.state.revealKey })}
            >
              {this.state.revealKey ? localized('Hide') : localized('Show')}
            </button>
          </div>
          <div className="ai-hint">{localized('Stored in this app’s local settings file.')}</div>
        </div>

        <div className="item ai-field">
          <div className="ai-fetch-row">
            <button
              type="button"
              className="btn"
              disabled={this.state.loadingModels || !this.state.baseUrl}
              onClick={() => this._fetchModels()}
            >
              {this.state.loadingModels ? localized('Fetching models…') : localized('Fetch models')}
            </button>
            <span className="ai-fetch-status">
              {this.state.status ||
                (models
                  ? localized('%1$@ speech models available', visible.length)
                  : localized('Ask the provider which transcription models this key can use.'))}
            </span>
          </div>
        </div>

        {this.state.error ? <div className="item ai-error">{this.state.error}</div> : null}

        <div className="item ai-field">
          <label>{localized('Model')}</label>
          <ModelPicker models={visible} value={this.state.model} onChange={this._onModelChange} />
        </div>

        <div className="item ai-field">
          <label htmlFor="stt-device">{localized('Input device')}</label>
          <div className="ai-key-row">
            <select id="stt-device" value={this.state.deviceId} onChange={this._onDeviceChange}>
              <option value="">{localized('System default')}</option>
              {(this.state.devices || []).map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-small" onClick={() => this._loadDevices()}>
              {localized('Refresh')}
            </button>
          </div>
          <div className="ai-hint">
            {this.state.devices && this.state.devices.length === 0
              ? localized('No microphone found. Connect one and refresh.')
              : localized('Recordings use the selected microphone.')}
          </div>
        </div>

        <div className="item ai-field">
          <label className="ai-toggle">
            <input
              type="checkbox"
              checked={this.state.micEnabled}
              onChange={this._onMicEnabledChange}
            />
            {localized('Microphone enabled')}
          </label>
          <div className="ai-hint">
            {localized(
              'Turn this off to disable dictation entirely without removing your provider settings.'
            )}
          </div>
        </div>

        <div className="item ai-field">
          <label htmlFor="stt-activation">{localized('Activation')}</label>
          <select
            id="stt-activation"
            value={this.state.activationMode}
            onChange={this._onActivationChange}
          >
            <option value="hold">{localized('Hold the key to talk')}</option>
            <option value="toggle">{localized('Press once to start, again to stop')}</option>
          </select>
        </div>

        <div className="item ai-field">
          <label htmlFor="stt-hotkey">{localized('Microphone key')}</label>
          <div className="ai-key-row">
            <input
              id="stt-hotkey"
              type="text"
              readOnly
              className="ai-hotkey-input"
              value={
                this.state.capturing ? localized('Press a key…') : formatHotkey(this.state.hotkey)
              }
              onKeyDown={this._onHotkeyKeyDown}
              onFocus={() => this.setState({ capturing: true })}
              onBlur={() => this.setState({ capturing: false })}
            />
            <button type="button" className="btn btn-small" onClick={this._onResetHotkey}>
              {localized('Reset')}
            </button>
          </div>
          <div className="ai-hint">
            {localized('Click the field and press the key you want to use. Esc cancels.')}
          </div>
        </div>
      </section>
    );
  }
}

/** Reads the saved dictation settings without going through AppEnv, so the tab stays pure. */
function readSTTConfigFrom(
  config: ConfigLike
): Omit<
  PreferencesSTTState,
  'models' | 'devices' | 'loadingModels' | 'error' | 'status' | 'revealKey' | 'capturing'
> {
  const provider = STT_PROVIDERS[0];
  const stringValue = (key: string) => {
    const value = config.get(key);
    return typeof value === 'string' ? value : '';
  };
  return {
    provider: stringValue(STT_CONFIG_KEYS.provider) || provider.id,
    baseUrl: stringValue(STT_CONFIG_KEYS.baseUrl) || provider.baseUrl,
    apiKey: readSecret('stt', config),
    model: stringValue(STT_CONFIG_KEYS.model),
    deviceId: stringValue(STT_CONFIG_KEYS.deviceId),
    // ConfigLike types `get` as string, but this key stores a real boolean.
    micEnabled: (config.get(STT_CONFIG_KEYS.micEnabled) as unknown) !== false,
    activationMode: config.get(STT_CONFIG_KEYS.activationMode) === 'toggle' ? 'toggle' : 'hold',
    hotkey: stringValue(STT_CONFIG_KEYS.hotkey) || DEFAULT_STT_HOTKEY,
  };
}

export default PreferencesSTT;
