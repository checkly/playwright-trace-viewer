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

const rangeFragmentName = '__checkly_trace_range';
const originalHashFragmentName = '__checkly_trace_hash';

export type ChecklyTraceRange = {
  start: number;
  end: number;
};

export function traceUriWithChecklyRange(traceUri: string, searchParams: URLSearchParams): string {
  const starts = searchParams.getAll('rangeStart');
  const ends = searchParams.getAll('rangeEnd');
  if (!starts.length && !ends.length)
    return traceUri;
  if (starts.length !== 1 || ends.length !== 1)
    throw new Error('Invalid Checkly trace byte range: rangeStart and rangeEnd must each be provided exactly once.');

  const range = parseRange(starts[0], ends[0]);
  const { uriWithoutHash, hash } = splitHash(traceUri);
  assertHttpUrl(uriWithoutHash);

  // The fragment keeps ranges in service worker cache keys and relative snapshot URLs,
  // but is never sent to the artifact server. Keep the signed URL before it byte-exact.
  const fragment = new URLSearchParams();
  fragment.set(rangeFragmentName, `v1:${range.start}-${range.end}`);
  if (hash)
    fragment.set(originalHashFragmentName, hash);
  return `${uriWithoutHash}#${fragment.toString()}`;
}

export function checklyTraceRangeFromUri(traceUri: string): { traceUri: string, range?: ChecklyTraceRange } {
  const { uriWithoutHash, hash } = splitHash(traceUri);
  const fragment = new URLSearchParams(hash);
  const ranges = fragment.getAll(rangeFragmentName);
  if (!ranges.length)
    return { traceUri };

  const originalHashes = fragment.getAll(originalHashFragmentName);
  const hasUnexpectedFields = [...fragment.keys()].some(name => name !== rangeFragmentName && name !== originalHashFragmentName);
  if (ranges.length !== 1 || originalHashes.length > 1 || hasUnexpectedFields)
    throw new Error('Invalid Checkly trace byte range metadata.');

  const match = /^v1:(0|[1-9]\d*)-(0|[1-9]\d*)$/.exec(ranges[0]);
  if (!match)
    throw new Error('Invalid Checkly trace byte range metadata.');
  const range = parseRange(match[1], match[2]);
  assertHttpUrl(uriWithoutHash);

  const originalHash = originalHashes[0];
  return {
    traceUri: `${uriWithoutHash}${originalHash ? `#${originalHash}` : ''}`,
    range,
  };
}

function parseRange(startValue: string, endValue: string): ChecklyTraceRange {
  if (!/^(0|[1-9]\d*)$/.test(startValue) || !/^(0|[1-9]\d*)$/.test(endValue))
    throw new Error('Invalid Checkly trace byte range: rangeStart and rangeEnd must be non-negative integers.');

  const start = Number(startValue);
  const end = Number(endValue);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end))
    throw new Error('Invalid Checkly trace byte range: rangeStart and rangeEnd must be safe integers.');
  if (end < start)
    throw new Error('Invalid Checkly trace byte range: rangeEnd must be greater than or equal to rangeStart.');
  return { start, end };
}

function assertHttpUrl(traceUri: string): void {
  let protocol: string;
  try {
    protocol = new URL(traceUri).protocol;
  } catch {
    throw new Error('Invalid Checkly trace URL.');
  }
  if (protocol !== 'http:' && protocol !== 'https:')
    throw new Error('Invalid Checkly trace URL: byte ranges require HTTP or HTTPS.');
}

function splitHash(uri: string): { uriWithoutHash: string, hash: string } {
  const hashIndex = uri.indexOf('#');
  if (hashIndex === -1)
    return { uriWithoutHash: uri, hash: '' };
  return { uriWithoutHash: uri.slice(0, hashIndex), hash: uri.slice(hashIndex + 1) };
}
