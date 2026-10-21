import { ComponentRegistry } from 'mailspring-exports';

import DictationButton from './dictation-button';

export function activate() {
  ComponentRegistry.register(DictationButton, {
    role: 'Composer:ActionButton',
  });
}

export function deactivate() {
  ComponentRegistry.unregister(DictationButton);
}

export function serialize() {
  return {};
}
