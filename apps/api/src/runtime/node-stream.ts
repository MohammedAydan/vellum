/**
 * Streams a Web `Response` into a Node `ServerResponse` chunk by chunk.
 *
 * Buffering the body (`res.end(await response.arrayBuffer())`) delays every
 * byte of a Server-Sent Events stream until the stream ends, so realtime
 * would deliver nothing for the whole stream lifetime. This writes each
 * chunk as it arrives and cancels the source when the client goes away.
 */

export interface NodeResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  write(chunk: Uint8Array): unknown;
  end(chunk?: Uint8Array): unknown;
  flushHeaders?: () => void;
  on?: (event: "close", listener: () => void) => unknown;
  writableEnded?: boolean;
}

export async function pipeWebResponse(
  response: Response,
  res: NodeResponseLike,
  extraHeaders: Record<string, string> = {}
): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);

  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  let clientGone = false;
  res.on?.("close", () => {
    if (!res.writableEnded) {
      clientGone = true;
      void reader.cancel().catch(() => undefined);
    }
  });
  res.flushHeaders?.();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || clientGone) break;
      if (value && value.byteLength > 0) res.write(value);
    }
  } finally {
    if (!clientGone) res.end();
  }
}
