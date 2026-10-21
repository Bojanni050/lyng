import React from 'react';
import { localized, Message } from 'mailspring-exports';
import {
  isChatConfigured,
  isTTSConfigured,
  readChatConfig,
  readTTSConfig,
} from '../../../src/ai/config';
import { htmlToText, summarizeEmail } from '../../../src/ai/completion';
import { AIProviderError } from '../../../src/ai/provider-catalog';
import { synthesizeSpeech } from '../../../src/ai/speech';

/** Reading a whole newsletter aloud is expensive; this is enough to be useful. */
const MAX_SPEECH_CHARS = 6000;

type Props = { message: Message };

type State = {
  busy: 'summary' | 'speech' | null;
  summary: string | null;
  error: string | null;
  speaking: boolean;
};

/**
 * The Summarize / Read aloud row above a message body.
 *
 * Both actions render only when their provider is configured, so a user who never set up AI
 * sees no extra chrome. Settings are read on each render rather than cached, because the user
 * may configure a provider in another window while this one is open.
 */
class MessageAIBar extends React.Component<Props, State> {
  static displayName = 'MessageAIBar';

  state: State = { busy: null, summary: null, error: null, speaking: false };

  private _controller: AbortController | null = null;
  private _audio: HTMLAudioElement | null = null;
  private _audioUrl: string | null = null;

  componentWillUnmount() {
    this._controller?.abort();
    this._stopAudio();
  }

  _stopAudio() {
    if (this._audio) {
      this._audio.pause();
      this._audio = null;
    }
    if (this._audioUrl) {
      URL.revokeObjectURL(this._audioUrl);
      this._audioUrl = null;
    }
  }

  _errorMessage(error: unknown, fallback: string): string {
    return error instanceof AIProviderError ? error.message : localized(fallback);
  }

  _onSummarize = () => {
    if (this.state.summary) {
      this.setState({ summary: null, error: null });
      return;
    }
    this._summarize();
  };

  async _summarize() {
    if (this.state.busy) return;
    this._controller?.abort();
    const controller = new AbortController();
    this._controller = controller;
    this.setState({ busy: 'summary', error: null });

    try {
      const summary = await summarizeEmail({
        config: readChatConfig(),
        subject: this.props.message.subject,
        from: this.props.message.fromContact?.name,
        body: this.props.message.body,
        plaintext: this.props.message.plaintext,
        snippet: this.props.message.snippet,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      this.setState({ busy: null, summary });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.setState({
        busy: null,
        error: this._errorMessage(error, 'The message could not be summarized.'),
      });
    }
  }

  _onReadAloud = () => {
    if (this.state.speaking) {
      this._stopAudio();
      this.setState({ speaking: false, busy: null });
      return;
    }
    this._speak();
  };

  async _speak() {
    if (this.state.busy) return;
    this._stopAudio();
    this._controller?.abort();
    const controller = new AbortController();
    this._controller = controller;
    this.setState({ busy: 'speech', error: null });

    const message = this.props.message;
    const raw = message.body || message.snippet || '';
    const text = (message.plaintext ? raw : htmlToText(raw)).slice(0, MAX_SPEECH_CHARS);

    try {
      const clip = await synthesizeSpeech({
        config: readTTSConfig(),
        text,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      this._audioUrl = URL.createObjectURL(clip.blob);
      this._audio = new Audio(this._audioUrl);
      this._audio.onended = () => {
        this._stopAudio();
        this.setState({ speaking: false });
      };
      this._audio.onerror = () => {
        this._stopAudio();
        this.setState({ speaking: false, error: localized('The audio could not be played.') });
      };
      await this._audio.play();
      this.setState({ busy: null, speaking: true });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.setState({
        busy: null,
        error: this._errorMessage(error, 'The message could not be read aloud.'),
      });
    }
  }

  render() {
    const chatReady = isChatConfigured();
    const ttsReady = isTTSConfigured();
    if (!chatReady && !ttsReady) return null;

    const { busy, summary, error, speaking } = this.state;

    return (
      <div className="ai-assist-bar">
        <div className="ai-assist-actions">
          {chatReady ? (
            <button
              type="button"
              className="btn btn-small"
              disabled={busy === 'summary'}
              onClick={this._onSummarize}
            >
              {busy === 'summary'
                ? localized('Summarizing…')
                : summary
                  ? localized('Hide summary')
                  : localized('Summarize')}
            </button>
          ) : null}
          {ttsReady ? (
            <button
              type="button"
              className="btn btn-small"
              disabled={busy === 'speech'}
              onClick={this._onReadAloud}
            >
              {busy === 'speech'
                ? localized('Preparing audio…')
                : speaking
                  ? localized('Stop')
                  : localized('Read aloud')}
            </button>
          ) : null}
        </div>
        {summary ? <div className="ai-assist-summary">{summary}</div> : null}
        {error ? <div className="ai-assist-error">{error}</div> : null}
      </div>
    );
  }
}

export default MessageAIBar;
