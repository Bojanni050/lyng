import React from 'react';
import classnames from 'classnames';
import { localized, Message, DraftEditingSession } from 'mailspring-exports';

import { readSTTConfig, isSTTConfigured, STTConfig } from '../../../src/ai/config';
import { formatHotkey } from '../../../src/ai/hotkey';
import { transcribeAudio } from '../../../src/ai/transcription';
import { AIProviderError } from '../../../src/ai/provider-catalog';
import * as Recorder from '../../../src/ai/recorder';
import { insertDictatedText } from './insert-text';

type Phase = 'idle' | 'recording' | 'transcribing';

interface Props {
  draft: Message;
  session: DraftEditingSession;
}

interface State {
  phase: Phase;
  error: string | null;
}

function MicIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M8 1.75a2.25 2.25 0 0 1 2.25 2.25v3.5a2.25 2.25 0 0 1-4.5 0V4A2.25 2.25 0 0 1 8 1.75Zm-4 5.5a.75.75 0 0 1 .75.75 3.25 3.25 0 0 0 6.5 0 .75.75 0 0 1 1.5 0 4.75 4.75 0 0 1-4 4.69v1.56h1.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5h1.5v-1.56a4.75 4.75 0 0 1-4-4.69A.75.75 0 0 1 4 7.25Z"
      />
    </svg>
  );
}

/**
 * Dictation button in the composer action bar.
 *
 * Both activation modes are handled here rather than through Electron's global shortcuts,
 * because "hold to talk" needs key-up as well as key-down, and the key should not reach the
 * text field while recording. Listening on the composer document means the key only speaks
 * while the user is already composing, which is exactly the case dictation serves.
 */
export default class DictationButton extends React.Component<Props, State> {
  static displayName = 'DictationButton';

  static containerRequired = false;

  state: State = { phase: 'idle', error: null };

  private _recording: Recorder.Recording | null = null;
  private _starting = false;
  private _stopWhenStarted = false;
  private _unmounted = false;

  componentDidMount() {
    document.addEventListener('keydown', this._onKeyDown, true);
    document.addEventListener('keyup', this._onKeyUp, true);
  }

  componentWillUnmount() {
    this._unmounted = true;
    document.removeEventListener('keydown', this._onKeyDown, true);
    document.removeEventListener('keyup', this._onKeyUp, true);
    this._discardRecording();
  }

  // The config is read per render on purpose: Preferences can change while a draft is open, and
  // reloading the tab is not something a user should have to do.
  _config(): STTConfig {
    return readSTTConfig();
  }

  _hotkeyLabel(config: STTConfig) {
    return formatHotkey(config.hotkey);
  }

  _onKeyDown = (event: KeyboardEvent) => {
    const config = this._config();
    if (!isSTTConfigured(config) || !config.micEnabled) return;
    if (event.code !== config.hotkey || event.repeat) return;

    // A letter hotkey must not steal keystrokes from form fields; the composer body itself is
    // contenteditable, so dictating while the caret is in the message stays possible.
    const tag = (event.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (config.activationMode === 'toggle') {
      event.preventDefault();
      if (this.state.phase === 'recording') this._stop();
      else this._start();
      return;
    }
    event.preventDefault();
    this._start();
  };

  _onKeyUp = (event: KeyboardEvent) => {
    const config = this._config();
    if (!isSTTConfigured(config) || !config.micEnabled) return;
    if (event.code !== config.hotkey) return;
    if (config.activationMode !== 'hold') return;
    event.preventDefault();
    if (this.state.phase === 'recording') this._stop();
    else if (this._starting) this._stopWhenStarted = true;
  };

  _onButtonDown = (event: React.MouseEvent) => {
    event.preventDefault();
    const config = this._config();
    if (config.activationMode === 'toggle') {
      if (this.state.phase === 'recording') this._stop();
      else this._start();
      return;
    }
    this._start();
  };

  _onButtonUp = () => {
    if (this._config().activationMode !== 'hold') return;
    if (this.state.phase === 'recording') this._stop();
    else if (this._starting) this._stopWhenStarted = true;
  };

  async _start() {
    if (this._starting || this.state.phase !== 'idle') return;
    const config = this._config();
    if (!isSTTConfigured(config)) {
      this.setState({
        error: localized('Choose a speech model and API key in Preferences → AI first.'),
      });
      return;
    }

    this._starting = true;
    this._stopWhenStarted = false;
    this.setState({ error: null });
    try {
      const recording = await Recorder.startRecording(config.deviceId);
      if (this._unmounted) {
        recording.cancel();
        return;
      }
      this._recording = recording;
      this.setState({ phase: 'recording' });
    } catch (error) {
      this._starting = false;
      this.setState({
        phase: 'idle',
        error:
          error instanceof AIProviderError
            ? error.message
            : localized('The microphone could not be started.'),
      });
      return;
    }
    this._starting = false;

    if (this._stopWhenStarted) {
      this._stopWhenStarted = false;
      this._stop();
    }
  }

  async _stop() {
    const recording = this._recording;
    if (!recording) return;
    this._recording = null;
    this.setState({ phase: 'transcribing' });

    const config = this._config();
    try {
      const audio = await recording.stop();
      if (audio.size < 1024) {
        // A tap of the key is not speech; sending it would only produce an empty transcript.
        this.setState({ phase: 'idle' });
        return;
      }
      const { text } = await transcribeAudio({
        config,
        audio,
        filename: Recorder.filenameForMimeType(audio.type || recording.mimeType),
      });
      if (this._unmounted) return;
      if (!text) {
        this.setState({ phase: 'idle', error: localized('No speech was recognized.') });
        return;
      }
      insertDictatedText(this.props.session, this.props.draft, `${text} `);
      this.setState({ phase: 'idle' });
    } catch (error) {
      if (this._unmounted) return;
      this.setState({
        phase: 'idle',
        error:
          error instanceof AIProviderError
            ? error.message
            : localized('The recording could not be transcribed.'),
      });
    }
  }

  _discardRecording() {
    if (this._recording) {
      this._recording.cancel();
      this._recording = null;
    }
  }

  _onDismissError = () => this.setState({ error: null });

  render() {
    const config = this._config();
    if (!isSTTConfigured(config) || !config.micEnabled) return null;

    const { phase, error } = this.state;
    const mode = config.activationMode;
    const hotkey = this._hotkeyLabel(config);

    const title =
      mode === 'hold'
        ? localized('Dictate a message (hold %@)', hotkey)
        : localized('Dictate a message (%@)', hotkey);

    return (
      <span className="dictation-composer-button">
        <button
          type="button"
          tabIndex={-1}
          className={classnames('btn btn-toolbar dictation-button', {
            recording: phase === 'recording',
            transcribing: phase === 'transcribing',
          })}
          title={title}
          aria-label={title}
          aria-pressed={phase === 'recording'}
          disabled={phase === 'transcribing'}
          onMouseDown={this._onButtonDown}
          onMouseUp={this._onButtonUp}
          onMouseLeave={this._onButtonUp}
        >
          <MicIcon />
          {phase === 'recording' ? (
            <span className="dictation-label">{localized('Recording…')}</span>
          ) : null}
          {phase === 'transcribing' ? (
            <span className="dictation-label">{localized('Transcribing…')}</span>
          ) : null}
        </button>
        {error ? (
          <span className="dictation-error" role="status">
            {error}
            <button
              type="button"
              tabIndex={-1}
              className="dictation-dismiss"
              title={localized('Dismiss')}
              onClick={this._onDismissError}
            >
              ×
            </button>
          </span>
        ) : null}
      </span>
    );
  }
}
