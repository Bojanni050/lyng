import { LRUCache } from 'lru-cache';
import { QuotedHTMLTransformer, localized, RegExpUtils } from 'mailspring-exports';

import { translateBlocks } from '../../../src/ai/translation';
import { isTranslationConfigured, readTranslationConfig } from '../../../src/ai/config';

export const TranslatePopupOptions = {
  English: 'en',
  Spanish: 'es',
  Russian: 'ru',
  Chinese: 'zh',
  Arabic: 'ar',
  French: 'fr',
  German: 'de',
  Italian: 'it',
  Japanese: 'ja',
  Portuguese: 'pt',
  Hindi: 'hi',
  Korean: 'ko',
};

export const AllLanguages = {
  az: 'Azerbaijan',
  ml: 'Malayalam',
  sq: 'Albanian',
  mt: 'Maltese',
  am: 'Amharic',
  mk: 'Macedonian',
  en: 'English',
  mi: 'Maori',
  ar: 'Arabic',
  mr: 'Marathi',
  hy: 'Armenian',
  mhr: 'Mari',
  af: 'Afrikaans',
  mn: 'Mongolian',
  eu: 'Basque',
  de: 'German',
  ba: 'Bashkir',
  ne: 'Nepali',
  be: 'Belarusian',
  no: 'Norwegian',
  bn: 'Bengali',
  pa: 'Punjabi',
  my: 'Burmese',
  pap: 'Papiamento',
  bg: 'Bulgarian',
  fa: 'Persian',
  bs: 'Bosnian',
  pl: 'Polish',
  cy: 'Welsh',
  pt: 'Portuguese',
  hu: 'Hungarian',
  ro: 'Romanian',
  vi: 'Vietnamese',
  ru: 'Russian',
  ht: 'Haitian (Creole)',
  ceb: 'Cebuano',
  gl: 'Galician',
  sr: 'Serbian',
  nl: 'Dutch',
  si: 'Sinhala',
  mrj: 'Hill Mari',
  sk: 'Slovakian',
  el: 'Greek',
  sl: 'Slovenian',
  ka: 'Georgian',
  sw: 'Swahili',
  gu: 'Gujarati',
  su: 'Sundanese',
  da: 'Danish',
  tg: 'Tajik',
  he: 'Hebrew',
  th: 'Thai',
  yi: 'Yiddish',
  tl: 'Tagalog',
  id: 'Indonesian',
  ta: 'Tamil',
  ga: 'Irish',
  tt: 'Tatar',
  it: 'Italian',
  te: 'Telugu',
  is: 'Icelandic',
  tr: 'Turkish',
  es: 'Spanish',
  udm: 'Udmurt',
  kk: 'Kazakh',
  uz: 'Uzbek',
  kn: 'Kannada',
  uk: 'Ukrainian',
  ca: 'Catalan',
  ur: 'Urdu',
  ky: 'Kyrgyz',
  fi: 'Finnish',
  zh: 'Chinese',
  fr: 'French',
  ko: 'Korean',
  hi: 'Hindi',
  xh: 'Xhosa',
  hr: 'Croatian',
  km: 'Khmer',
  cs: 'Czech',
  lo: 'Laotian',
  sv: 'Swedish',
  la: 'Latin',
  gd: 'Scottish',
  lv: 'Latvian',
  et: 'Estonian',
  lt: 'Lithuanian',
  eo: 'Esperanto',
  lb: 'Luxembourgish',
  jv: 'Javanese',
  mg: 'Malagasy',
  ja: 'Japanese',
  ms: 'Malay',
};

function forEachTranslatableText(doc: Document, callback: (el: Node, text: string) => void) {
  const textWalker = document.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const urlRegexp = RegExpUtils.urlRegex({ matchStartOfString: true, matchTailOfString: true });
  const usaAddressRegexp = /, [A-Z]{2},? [A-Z]{2,3},? [\d]{5}/; // matches ", CA 94114"

  while (textWalker.nextNode()) {
    const node = textWalker.currentNode;
    if (['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE'].includes(node.parentElement.tagName)) {
      continue;
    }

    if (node.parentElement.closest('.notranslate')) {
      continue; // the HTML explicitly requests this text not be translated
    }

    const text = node.textContent.replace(/\s{2,}/g, ' ');
    if (!/[A-Za-z\p{L}]+/u.test(text)) {
      continue; // there are no latin or unicode letters in the string
    }
    if (urlRegexp.test(text.trim())) {
      continue; // purely a plaintext link
    }

    if (text.length < 250 && usaAddressRegexp.test(text)) {
      continue; // looks very much like a US address. Don't awkwardly translate these
    }

    const closestWithFont = node.parentElement.closest('[style*=font]');
    if (closestWithFont instanceof HTMLElement) {
      const family = closestWithFont.style.fontFamily || closestWithFont.style.font || '';
      if (
        family.includes('monospace') ||
        family.includes('Monaco') ||
        family.includes('Lucida Console') ||
        family.includes('Courier')
      ) {
        continue; // the text is in a monospace font and is probably a meaningful "value / variable"
      }

      const size = Number((closestWithFont.style.fontSize || '').replace(/[A-Za-z]+/g, ''));
      if (size > 0 && size < 12) {
        continue; // the text is tiny or hidden, don't waste translation characters on footer stuff
      }
    }

    if (text.length > 2) {
      // we will translate this text. But trim out large blocks of whitespace that may
      // exist in the raw textContent to avoid those counting as translation characters.
      // NOTE: We use node.textContent here, not the trimmed version. The leading/trailing
      // space are necessary for things like <span>this is a <a>link</a></span>
      callback(node, text);
    }
  }
}

// We maintain a cache of blocks of text we've translated. Because the user may have a whole
// mailbox of very similar or templated emails, this can cut down on the amount of text we
// need to translate for a new email dramatically.
const translatedSnippetCache = new LRUCache<string, string>({ max: 1000 });
let translatedSnippetLang = '';

export async function translateMessageBody(
  html: string,
  targetLang?: string,
  silent = false
): Promise<string | false> {
  if (!isTranslationConfigured()) {
    if (!silent) {
      AppEnv.showErrorDialog({
        title: localized('Translation is Not Configured'),
        message: localized(
          'Add a translation provider in Preferences › AI › Translation to translate messages.'
        ),
      });
    }
    return false;
  }
  if (translatedSnippetLang !== targetLang) {
    translatedSnippetCache.clear();
    translatedSnippetLang = targetLang;
  }

  const replyHtml = QuotedHTMLTransformer.removeQuotedHTML(html);

  // break the document down into text blocks to translate. We don't send the HTML
  // because translation providers bill by the character and it's unclear if a giant
  // <style> tag counts.
  const domParser = new DOMParser();
  const doc = domParser.parseFromString(replyHtml, 'text/html');

  // Collect every translatable node in document order, in one pass, so each translation
  // result lands on exactly the node it was requested for. A copy the cache answers with
  // `cached`, and nodes past the per-message character budget with `overLimit`; nothing is
  // removed from `entries`, so every block sent to the provider stays positionally aligned.
  const entries: { node: Node; text: string; cached?: string; overLimit?: boolean }[] = [];
  let totalChars = 0;

  forEachTranslatableText(doc, (node, text) => {
    const cached = translatedSnippetCache.get(text);
    const overLimit = totalChars > 5000;
    if (!cached && !overLimit) totalChars += text.length + 7; // <b></b>, as the old server billed
    entries.push({
      node,
      text,
      ...(cached ? { cached } : {}),
      ...(overLimit ? { overLimit } : {}),
    });
  });

  const srcIndices: number[] = [];
  const blocks: string[] = [];
  entries.forEach((entry, index) => {
    if (entry.cached !== undefined || entry.overLimit) return;
    srcIndices.push(index);
    blocks.push(entry.text);
  });

  let results: string[] = [];

  // Make the translation request
  if (blocks.length > 0) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      results = await translateBlocks({
        blocks,
        targetLang,
        config: readTranslationConfig(),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (!silent) {
        AppEnv.showErrorDialog({
          title: localized('Language Conversion Failed'),
          message: (error as Error)?.message || error.toString(),
        });
      }
      return false;
    }
    clearTimeout(timeout);
  }

  // Merge the results back in order: srcIndices[i] names the entries slot that produced
  // blocks[i], and the cached answers fill the rest from the LRU cache.
  results.forEach((translated, i) => {
    const entry = entries[srcIndices[i]];
    if (!entry || typeof translated !== 'string') return;
    entry.node.textContent = translated;
    translatedSnippetCache.set(entry.text, translated);
  });
  entries.forEach((entry) => {
    if (entry.cached !== undefined) entry.node.textContent = entry.cached;
  });

  // Put the quoted text back in!
  return QuotedHTMLTransformer.appendQuotedHTML(doc.body.innerHTML, html);
}
