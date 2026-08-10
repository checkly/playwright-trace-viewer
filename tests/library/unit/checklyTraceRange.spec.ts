/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { expect, test } from '@playwright/test';
import { checklyTraceRangeFromUri, traceUriWithChecklyRange } from '../../../packages/isomorphic/trace/checklyTraceRange';

test('leaves ordinary trace URLs unchanged', () => {
  const traceUri = 'https://example.com/trace.zip?signature=a%2Fb#original%2Fhash';
  expect(traceUriWithChecklyRange(traceUri, new URLSearchParams())).toBe(traceUri);
  expect(checklyTraceRangeFromUri(traceUri)).toEqual({ traceUri });
});

test('round trips a signed URL and byte range without reserializing the URL', () => {
  const traceUri = 'https://example.com:443/trace.zip?signature=a%2Fb&empty=#original%2Fhash';
  const rangedTraceUri = traceUriWithChecklyRange(traceUri, new URLSearchParams({
    rangeStart: '0',
    rangeEnd: '1234',
  }));

  expect(rangedTraceUri).toContain('#__checkly_trace_range=v1%3A0-1234');
  expect(checklyTraceRangeFromUri(rangedTraceUri)).toEqual({
    traceUri,
    range: { start: 0, end: 1234 },
  });
});

for (const [name, query] of [
  ['a missing end', 'rangeStart=1'],
  ['duplicate values', 'rangeStart=1&rangeStart=2&rangeEnd=3'],
  ['a negative start', 'rangeStart=-1&rangeEnd=3'],
  ['a decimal end', 'rangeStart=1&rangeEnd=3.5'],
  ['leading zeroes', 'rangeStart=01&rangeEnd=3'],
  ['an unsafe end', 'rangeStart=1&rangeEnd=9007199254740992'],
  ['an inverted range', 'rangeStart=4&rangeEnd=3'],
] as const) {
  test(`rejects ${name}`, () => {
    expect(() => traceUriWithChecklyRange('https://example.com/trace.zip', new URLSearchParams(query))).toThrow(/Invalid Checkly trace byte range/);
  });
}

test('rejects ranged non-HTTP URLs', () => {
  expect(() => traceUriWithChecklyRange('file:///trace.zip', new URLSearchParams('rangeStart=0&rangeEnd=1'))).toThrow(/require HTTP or HTTPS/);
});

test('rejects malformed internal range metadata', () => {
  expect(() => checklyTraceRangeFromUri('https://example.com/trace.zip#__checkly_trace_range=v1%3A0-infinity')).toThrow(/Invalid Checkly trace byte range metadata/);
  expect(() => checklyTraceRangeFromUri('https://example.com/trace.zip#__checkly_trace_range=v1%3A0-1&unexpected=value')).toThrow(/Invalid Checkly trace byte range metadata/);
});
