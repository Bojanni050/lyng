import { Message, DraftEditingSession } from 'mailspring-exports';

/**
 * Puts dictated text where the caret is.
 *
 * The composer has two editors: the rich Slate editor (which accepts a `insertText` command) and
 * the plaintext `<textarea>` (which only understands DOM input events). Both are reached through
 * the session's mounted editor, the same object the composer itself uses to move the caret around.
 * When neither is available — a composer window still mounting, for instance — the text is
 * appended to the draft body instead of being dropped.
 */
export function insertDictatedText(
  session: DraftEditingSession,
  draft: Message,
  text: string
): 'editor' | 'body' {
  const editor = (session as any)?._mountedEditor;

  if (editor && typeof editor.command === 'function') {
    if (typeof editor.focus === 'function') editor.focus();
    editor.command('insertText', text);
    return 'editor';
  }

  const textarea: HTMLTextAreaElement | undefined = editor?._el?.current;
  if (textarea) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const next = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
    textarea.focus();
    // Assigning through the prototype setter is the only way to make React's onChange see this;
    // a plain `textarea.value = ...` updates the DOM without notifying the draft.
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setValue) setValue.call(textarea, next);
    else textarea.value = next;
    textarea.setSelectionRange(start + text.length, start + text.length);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return 'editor';
  }

  const body = draft?.body || '';
  session.changes.add({ body: `${body}${escapeHtml(text)}` });
  return 'body';
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
