import { Actions, DatabaseStore, Message, SyncbackMetadataTask } from 'mailspring-exports';

/**
 * Fills in the data the vendor's server used to write.
 *
 * The open-tracking and link-tracking packages render `open_count` / `open_data` /
 * `click_count` / `click_data` from message metadata, but nothing in the open-source
 * client ever writes those fields — `link.getmailspring.com` did, by pushing metadata
 * down through the sync engine. Pointing PLUGIN_URL at a self-hosted server (see each
 * package's `serverUrl`) only fixes the outbound pixel/redirect; this poller closes the
 * loop by asking that server what happened and queueing the same SyncbackMetadataTask
 * the vendor's server would have produced.
 *
 * Read-only towards the DB: the UI cannot write, so changes go through the sync engine
 * as tasks, exactly like send-later's metadata updates.
 */

const OPEN_TRACKING = 'open-tracking';
const LINK_TRACKING = 'link-tracking';
const DEFAULT_BASE_URL = 'https://momo.studiovanderheide.nl';
const POLL_INTERVAL_MS = 60 * 1000;

type ClickData = { recipient: string; timestamp: number };

type ServerMessage = {
  messageId: string;
  accountId?: string | null;
  opens: number;
  openData: ClickData[];
  links: { index: number; clickCount: number; clickData: ClickData[] }[];
};

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function activate() {
  timer = setInterval(() => {
    void pollOnce();
  }, POLL_INTERVAL_MS);
  void pollOnce();
}

export function deactivate() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function serialize() {}

function baseUrl() {
  const fromEnv = process.env.MAILSPRING_TRACKING_URL;
  return (fromEnv || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** Set on the tracking server as API_TOKEN; empty means /api/tracked is open. */
function trackedUrl() {
  const url = `${baseUrl()}/api/tracked`;
  const token = process.env.MAILSPRING_TRACKING_TOKEN;
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}

function getJSON(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? require('node:https') : require('node:http');
    const req = lib.get(url, { timeout: 10_000 }, (res) => {
      if (!res.statusCode || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`${url} responded ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${url} timed out`)));
    req.on('error', reject);
  });
}

function messagesFor(headerMessageId: string): Promise<Message[]> {
  return new Promise((resolve) => {
    DatabaseStore.findAll<Message>(Message, { headerMessageId })
      .then((messages: Message[]) => resolve(messages || []))
      .catch(() => resolve([]));
  });
}

function sameData(a: ClickData[] = [], b: ClickData[] = []) {
  if (a.length !== b.length) return false;
  return a.every(
    (entry, i) => entry.recipient === b[i].recipient && entry.timestamp === b[i].timestamp
  );
}

async function applyOpenTracking(entry: ServerMessage, message: Message) {
  const metadata = message.metadataForPluginId(OPEN_TRACKING);
  if (!metadata) return; // tracking was never enabled for this message
  const openData = entry.openData || [];
  if ((metadata.open_count || 0) === entry.opens && sameData(metadata.open_data || [], openData)) {
    return;
  }
  Actions.queueTask(
    SyncbackMetadataTask.forSaving({
      model: message,
      pluginId: OPEN_TRACKING,
      value: { ...metadata, uid: entry.messageId, open_count: entry.opens, open_data: openData },
    })
  );
}

async function applyLinkTracking(entry: ServerMessage, message: Message) {
  const metadata = message.metadataForPluginId(LINK_TRACKING);
  if (!metadata || !Array.isArray(metadata.links)) return;

  let changed = false;
  const links = metadata.links.map((link, index) => {
    const remote = (entry.links || []).find((candidate) => candidate.index === index);
    if (!remote) return link;
    if (
      (link.click_count || 0) === remote.clickCount &&
      sameData(link.click_data || [], remote.clickData)
    ) {
      return link;
    }
    changed = true;
    return { ...link, click_count: remote.clickCount, click_data: remote.clickData };
  });
  if (!changed) return;

  Actions.queueTask(
    SyncbackMetadataTask.forSaving({
      model: message,
      pluginId: LINK_TRACKING,
      value: { ...metadata, uid: entry.messageId, links },
    })
  );
}

export async function pollOnce() {
  if (inFlight) return;
  inFlight = true;
  try {
    const payload = await getJSON(trackedUrl());
    const entries: ServerMessage[] = (payload && payload.messages) || [];
    for (const entry of entries) {
      const messages = await messagesFor(entry.messageId);
      const message = messages.find(
        (candidate) =>
          !candidate.draft && (entry.accountId == null || candidate.accountId === entry.accountId)
      );
      if (!message) continue;
      await applyOpenTracking(entry, message);
      await applyLinkTracking(entry, message);
    }
  } catch (error) {
    // The tracking server is optional: stay quiet and retry on the next tick.
    console.warn(`tracking-sync: ${(error as Error).message}`);
  } finally {
    inFlight = false;
  }
}
