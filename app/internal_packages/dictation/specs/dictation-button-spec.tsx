import React from 'react';
import ReactDOM from 'react-dom';
import DictationButton from '../lib/dictation-button';
import * as Recorder from '../../../src/ai/recorder';
import * as Transcription from '../../../src/ai/transcription';

const STT_KEYS: { [key: string]: string } = {
  'core.stt.provider': 'mistral',
  'core.stt.baseUrl': 'https://api.mistral.ai/v1',
  'core.stt.apiKey': 'test-key',
  'core.stt.model': 'voxtral-mini-transcribe-3',
  'core.stt.deviceId': '',
  'core.stt.micEnabled': 'true',
  'core.stt.activationMode': 'hold',
  'core.stt.hotkey': 'ControlRight',
};

/** Drain the promises a recording start/stop passes through; the spec runner fakes timers. */
async function settle() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
  (global as any).advanceClock(1);
}

function key(type: 'keydown' | 'keyup', code = 'ControlRight') {
  document.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
}

describe('DictationButton', function () {
  let container: HTMLElement;
  let editor: { command: jasmine.Spy; focus: jasmine.Spy };
  let addChange: jasmine.Spy;
  let session: any;
  let draft: any;
  let startRecording: jasmine.Spy;

  beforeEach(function () {
    spyOn(AppEnv.config, 'get').andCallFake((keyName: string) => STT_KEYS[keyName]);
    editor = { command: jasmine.createSpy('command'), focus: jasmine.createSpy('focus') };
    addChange = jasmine.createSpy('changes.add');
    session = { changes: { add: addChange }, _mountedEditor: editor };
    draft = { id: 'draft-1', body: '<div>Hi</div>' };
    container = document.createElement('div');
    document.body.appendChild(container);

    startRecording = spyOn(Recorder, 'startRecording').andReturn(
      Promise.resolve({
        mimeType: 'audio/webm',
        stop: () => Promise.resolve(new Blob([new Uint8Array(2048)], { type: 'audio/webm' })),
        cancel: () => {},
      })
    );
    spyOn(Transcription, 'transcribeAudio').andReturn(Promise.resolve({ text: 'hello' }));
  });

  afterEach(function () {
    ReactDOM.unmountComponentAtNode(container);
    container.remove();
  });

  function render() {
    ReactDOM.render(React.createElement(DictationButton, { draft, session }), container);
  }

  it('renders nothing until a speech provider is configured', function () {
    (AppEnv.config.get as any).andCallFake(() => null);
    render();
    expect(container.querySelector('.dictation-button')).toBeNull();
  });

  it('records while the hotkey is held and inserts the transcript', async function () {
    render();
    expect(container.querySelector('.dictation-button')).not.toBeNull();

    key('keydown');
    await settle();
    expect(startRecording).toHaveBeenCalled();
    expect(container.textContent).toContain('Recording');

    key('keyup');
    await settle();

    expect((Transcription.transcribeAudio as any).calls.length).toBe(1);
    expect((editor.command as any).calls[0].args).toEqual(['insertText', 'hello ']);
  });

  it('ignores a hotkey press that starts inside a text field', async function () {
    render();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'ControlRight', bubbles: true }));
    await settle();
    expect(startRecording).not.toHaveBeenCalled();
    input.remove();
  });

  it('reports an empty transcript instead of inserting nothing', async function () {
    (Transcription.transcribeAudio as any).andReturn(Promise.resolve({ text: '' }));
    render();
    key('keydown');
    await settle();
    key('keyup');
    await settle();
    expect(container.textContent).toContain('No speech was recognized');
    expect((editor.command as any).calls.length).toBe(0);
  });

  it('can dismiss an error', async function () {
    (Transcription.transcribeAudio as any).andReturn(Promise.reject(new Error('nope')));
    render();
    key('keydown');
    await settle();
    key('keyup');
    await settle();
    expect(container.querySelector('.dictation-error')).not.toBeNull();
    (container.querySelector('.dictation-dismiss') as HTMLElement).click();
    await settle();
    expect(container.querySelector('.dictation-error')).toBeNull();
  });

  it('toggles on a single press in toggle mode', async function () {
    STT_KEYS['core.stt.activationMode'] = 'toggle';
    try {
      render();
      key('keydown');
      await settle();
      expect(container.textContent).toContain('Recording');
      key('keydown');
      await settle();
      expect((Transcription.transcribeAudio as any).calls.length).toBe(1);
    } finally {
      STT_KEYS['core.stt.activationMode'] = 'hold';
    }
  });
});
