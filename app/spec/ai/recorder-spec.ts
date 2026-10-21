import {
  explainMicrophoneError,
  filenameForMimeType,
  preferredMimeType,
  startRecording,
} from '../../src/ai/recorder';

/**
 * The recorder is the one place in the dictation path that touches browser APIs which do not
 * exist in the spec environment. These stubs model MediaRecorder closely enough that the real
 * start/stop/cancel logic runs, including the stream teardown that keeps the OS microphone
 * light off after a recording.
 */

class FakeMediaRecorder {
  static isTypeSupported = () => true;

  state = 'inactive';
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    public stream: unknown,
    options?: { mimeType?: string }
  ) {
    this.mimeType = (options && options.mimeType) || 'audio/webm';
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    if (this.ondataavailable) {
      this.ondataavailable({ data: new Blob(['dictated words'], { type: this.mimeType }) });
    }
    if (this.onstop) this.onstop();
  }
}

describe('dictation recorder', function () {
  const originalMediaRecorder = (window as any).MediaRecorder;
  const originalMediaDevices = navigator.mediaDevices;
  let tracks: Array<{ stop: jasmine.Spy }>;

  beforeEach(function () {
    tracks = [{ stop: jasmine.createSpy('track.stop') }, { stop: jasmine.createSpy('track.stop') }];
    (window as any).MediaRecorder = FakeMediaRecorder;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: jasmine.createSpy('getUserMedia').andReturn(
          Promise.resolve({
            getTracks: () => tracks,
          })
        ),
      },
    });
  });

  afterEach(function () {
    (window as any).MediaRecorder = originalMediaRecorder;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: originalMediaDevices,
    });
  });

  it('names the file after the container so the provider can sniff it', function () {
    expect(filenameForMimeType('audio/webm;codecs=opus')).toBe('dictation.webm');
    expect(filenameForMimeType('audio/ogg;codecs=opus')).toBe('dictation.ogg');
    expect(filenameForMimeType('audio/mp4')).toBe('dictation.m4a');
  });

  it('records with the chosen device and returns the audio on stop', async function () {
    const recording = await startRecording('mic-2');
    const gum = (navigator.mediaDevices.getUserMedia as any).calls[0].args[0];
    expect(gum.audio.deviceId.exact).toBe('mic-2');
    expect(gum.video).toBe(false);

    const audio = await recording.stop();
    expect(audio.size).toBeGreaterThan(0);
    expect(audio.type).toContain('audio/webm');
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(tracks[1].stop).toHaveBeenCalled();
  });

  it('uses the system default when no device is chosen', async function () {
    await startRecording('');
    const gum = (navigator.mediaDevices.getUserMedia as any).calls[0].args[0];
    expect(gum.audio).toBe(true);
  });

  it('releases the microphone when a recording is cancelled', async function () {
    const recording = await startRecording();
    recording.cancel();
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('explains a blocked microphone in words a user can act on', function () {
    expect(explainMicrophoneError({ name: 'NotAllowedError' })).toContain('privacy settings');
    expect(explainMicrophoneError({ name: 'NotFoundError' })).toContain('Preferences');
    expect(explainMicrophoneError({ name: 'NotReadableError' })).toContain('another app');
    expect(explainMicrophoneError(new Error('boom'))).toContain('could not be started');
  });

  it('reports a readable error when the microphone is blocked', async function () {
    (navigator.mediaDevices.getUserMedia as any).andReturn(
      Promise.reject({ name: 'NotAllowedError' })
    );
    let message = '';
    try {
      await startRecording();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('privacy settings');
  });

  it('picks a container this build can encode', function () {
    expect(preferredMimeType()).toBe('audio/webm;codecs=opus');
  });
});
