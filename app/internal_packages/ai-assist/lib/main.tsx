import { ComponentRegistry } from 'mailspring-exports';
import MessageAIBar from './message-ai-bar';

export function activate() {
  ComponentRegistry.register(MessageAIBar, { role: 'message:BodyHeader' });
}

export function deactivate() {
  ComponentRegistry.unregister(MessageAIBar);
}
