import { session } from 'electron';

/**
 * Dictation records through `getUserMedia`, which needs the app's own window to be allowed to
 * use the microphone. Nothing else is granted: view sessions install their own denying handler
 * in `view-sessions.ts`, and this only opens the audio half of `media` so a compromised page in
 * the app shell cannot ask for a camera.
 */
export function allowMicrophoneInAppWindows() {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (permission !== 'media') return callback(false);
    const requested: string[] = ((details || {}) as { mediaTypes?: string[] }).mediaTypes || [];
    callback(requested.every((type) => type === 'audio'));
  });

  ses.setPermissionCheckHandler((_contents, permission) => permission === 'media');
}
