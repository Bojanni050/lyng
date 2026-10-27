import { secureStorage } from '../../src/key-manager';
import {
  SECRET_LEGACY_KEYS,
  loadSecrets,
  readSecret,
  resetSecretsForTests,
  storeSecret,
} from '../../src/ai/secrets';

const BLOB_KEY = 'credentials-ai';

describe('AI secrets', function () {
  let stored: { [key: string]: any };
  let encryptionPayload: string;
  let encryptionAvailable: boolean;

  beforeEach(function () {
    resetSecretsForTests();

    stored = {};
    encryptionPayload = '';
    encryptionAvailable = true;
    spyOn(AppEnv.config, 'get').andCallFake((key: string) => stored[key]);
    spyOn(AppEnv.config, 'set').andCallFake((key: string, val: any) => {
      stored[key] = val;
    });
    spyOn(AppEnv.config, 'unset').andCallFake((key: string) => {
      delete stored[key];
    });
    spyOn(secureStorage, 'isAvailable').andCallFake(() => Promise.resolve(encryptionAvailable));
    spyOn(secureStorage, 'encrypt').andCallFake((plaintext: string) => {
      encryptionPayload = plaintext;
      return Promise.resolve(Buffer.from('v11-locked'));
    });
    spyOn(secureStorage, 'decrypt').andCallFake(
      () => Promise.resolve({ result: encryptionPayload, shouldReEncrypt: false }) as any
    );
    spyOn(secureStorage, 'decryptLegacy').andCallFake(() => {
      throw new Error('sync backend unavailable');
    });
  });

  describe('storeSecret', function () {
    it('writes the key into the encrypted blob and removes the plain-text slot', async function () {
      stored[SECRET_LEGACY_KEYS.ai] = 'sk-plain';

      await storeSecret('ai', 'sk-1');

      const blob = Buffer.from(stored[BLOB_KEY] as string, 'base64').toString('utf-8');
      expect(blob).toBe('v11-locked');
      expect(encryptionPayload).toBe('{"ai":"sk-1"}');
      expect(readSecret('ai')).toBe('sk-1');
      expect(stored[SECRET_LEGACY_KEYS.ai]).toBeUndefined();
    });

    it('keeps already stored scopes when writing another one', async function () {
      await storeSecret('ai', 'sk-1');

      await storeSecret('tts', 'sk-2');

      expect(encryptionPayload).toBe('{"ai":"sk-1","tts":"sk-2"}');
      expect(readSecret('ai')).toBe('sk-1');
      expect(readSecret('tts')).toBe('sk-2');
    });

    it('clears a scope until the blob ends up empty and disappears', async function () {
      await storeSecret('ai', 'sk-1');
      encryptionPayload = '';
      await storeSecret('ai', '');

      expect(stored[BLOB_KEY]).toBeUndefined();
      expect(readSecret('ai')).toBe('');
    });

    it('falls back to the plain-text slot when encryption is unavailable', async function () {
      encryptionAvailable = false;
      spyOn(console, 'warn');
      await storeSecret('ai', 'sk-1');

      expect(stored[BLOB_KEY]).toBeUndefined();
      expect(stored[SECRET_LEGACY_KEYS.ai]).toBe('sk-1');
      expect(readSecret('ai')).toBe('sk-1');
      expect(stored[SECRET_LEGACY_KEYS.tts]).toBeUndefined();
    });
  });

  describe('readSecret', function () {
    it('falls back to the plain-text slot until the cache has loaded', function () {
      stored[SECRET_LEGACY_KEYS.stt] = 'sk-plain';

      expect(readSecret('stt')).toBe('sk-plain');
    });
  });

  describe('loadSecrets', function () {
    it('fills the cache from the encrypted blob', async function () {
      await storeSecret('ai', 'sk-1');
      resetSecretsForTests();

      await loadSecrets();

      expect(readSecret('ai')).toBe('sk-1');
    });

    it('moves plain-text keys from earlier versions into the encrypted blob', async function () {
      stored[SECRET_LEGACY_KEYS.ai] = 'sk-plain';

      await loadSecrets();

      expect(encryptionPayload).toContain('sk-plain');
      expect(readSecret('ai')).toBe('sk-plain');
      expect(stored[SECRET_LEGACY_KEYS.ai]).toBeUndefined();
    });

    it('keeps the plain-text key when the blob cannot be decrypted', async function () {
      stored[BLOB_KEY] = 'bm90LXJlYWxsLWRhdGE=';
      (secureStorage.decrypt as jasmine.Spy).andCallFake(() =>
        Promise.reject(new Error('locked keyring'))
      );

      await loadSecrets();

      expect(readSecret('ai')).toBe('');
    });

    it('does nothing when nothing is stored', async function () {
      await loadSecrets();

      expect(secureStorage.encrypt).not.toHaveBeenCalled();
      expect(stored[BLOB_KEY]).toBeUndefined();
    });
  });
});
