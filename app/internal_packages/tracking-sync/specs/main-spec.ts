import { EventEmitter } from 'events';
import { Actions, DatabaseStore, Message } from 'mailspring-exports';
import { pollOnce } from '../lib/main';

const http = require('node:http');
const HEADER_MESSAGE_ID = '<duplicate@example.test>';

function trackedMessage(id: string, accountId: string) {
  return {
    id,
    accountId,
    headerMessageId: HEADER_MESSAGE_ID,
    draft: false,
    metadataForPluginId: (pluginId: string) =>
      pluginId === 'open-tracking' ? { open_count: 0, open_data: [] } : null,
  } as unknown as Message;
}

function stubResponses(responses: { statusCode: number; body?: unknown }[]) {
  let nextResponse = 0;
  spyOn(http, 'get').andCallFake((_url: any, _options: any, onResponse: any) => {
    const request = new EventEmitter() as any;
    const responseData = responses[nextResponse++];

    process.nextTick(() => {
      const response = new EventEmitter() as any;
      response.statusCode = responseData.statusCode;
      response.setEncoding = () => {};
      response.resume = () => {};
      onResponse(response);
      if (responseData.body !== undefined) {
        response.emit('data', JSON.stringify(responseData.body));
        response.emit('end');
      }
    });

    request.destroy = (error: Error) => request.emit('error', error);
    return request;
  });
}

describe('tracking-sync pollOnce', function () {
  let messages: Message[];
  let previousTrackingUrl: string | undefined;
  let previousTrackingToken: string | undefined;

  beforeEach(() => {
    previousTrackingUrl = process.env.MAILSPRING_TRACKING_URL;
    previousTrackingToken = process.env.MAILSPRING_TRACKING_TOKEN;
    process.env.MAILSPRING_TRACKING_URL = 'http://tracking.example.test';
    delete process.env.MAILSPRING_TRACKING_TOKEN;
    messages = [];

    spyOn(DatabaseStore, 'findAll').andCallFake(() => Promise.resolve(messages) as any);
    spyOn(Actions, 'queueTask');
  });

  afterEach(() => {
    if (previousTrackingUrl === undefined) delete process.env.MAILSPRING_TRACKING_URL;
    else process.env.MAILSPRING_TRACKING_URL = previousTrackingUrl;
    if (previousTrackingToken === undefined) delete process.env.MAILSPRING_TRACKING_TOKEN;
    else process.env.MAILSPRING_TRACKING_TOKEN = previousTrackingToken;
  });

  it('matches a tracked message to the server-reported account when header IDs collide', async () => {
    const firstAccountMessage = trackedMessage('message-a', 'account-a');
    const matchingMessage = trackedMessage('message-b', 'account-b');
    messages = [firstAccountMessage, matchingMessage];
    stubResponses([
      {
        statusCode: 200,
        body: {
          messages: [
            {
              messageId: HEADER_MESSAGE_ID,
              accountId: 'account-b',
              opens: 1,
              openData: [{ recipient: 'person@example.test', timestamp: 100 }],
              links: [],
            },
          ],
        },
      },
    ]);

    await pollOnce();

    const task = (Actions.queueTask as any).calls[0].args[0];
    expect(task.modelId).toBe('message-b');
  });

  it('retries on the next poll after the tracking server returns an error', async () => {
    messages = [trackedMessage('message-a', 'account-a')];
    spyOn(console, 'warn');
    stubResponses([
      { statusCode: 503 },
      {
        statusCode: 200,
        body: {
          messages: [
            {
              messageId: HEADER_MESSAGE_ID,
              accountId: 'account-a',
              opens: 1,
              openData: [{ recipient: 'person@example.test', timestamp: 100 }],
              links: [],
            },
          ],
        },
      },
    ]);

    await pollOnce();
    expect(Actions.queueTask).not.toHaveBeenCalled();

    await pollOnce();

    expect((http.get as jasmine.Spy).calls.length).toBe(2);
    expect(Actions.queueTask).toHaveBeenCalled();
  });
});
