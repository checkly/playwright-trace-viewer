/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// A trace stored as a byte range of a larger object is addressed as `<url>#bytes=<start>-<end>`.
// The range rides in the trace uri itself so that every request carrying it (snapshots,
// resources, reloads after a service worker restart) reads the same bytes. Fetch never sends
// the fragment, and its value is the Range header to send instead.
const byteRangeFragment = /#(bytes=\d+-\d+)$/;

export function withByteRange(traceUri: string, start: string | null, end: string | null): string {
  if (!start || !end || !/^\d+$/.test(start) || !/^\d+$/.test(end))
    return traceUri;
  return `${traceUri.replace(/#.*$/s, '')}#bytes=${start}-${end}`;
}

export function splitByteRange(traceUri: string): { url: string, range?: string } {
  const match = traceUri.match(byteRangeFragment);
  if (!match)
    return { url: traceUri };
  return { url: traceUri.slice(0, match.index), range: match[1] };
}
