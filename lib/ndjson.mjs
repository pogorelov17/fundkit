// Newline-delimited JSON framing, used on stdio and on the control socket.

/** Call `onLine` with every non-empty line of `stream`. */
export function onLines(stream, onLine) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim()) onLine(line);
    }
  });
}

/** Parse a line as JSON, or return undefined. */
export function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Call `onMessage` with every line of `stream` that parses as JSON; other lines are dropped. */
export function onJsonLines(stream, onMessage) {
  onLines(stream, (line) => {
    const message = parseJson(line);
    if (message !== undefined) onMessage(message);
  });
}

/** Write one JSON line if the stream is still open; a closed peer is not an error. */
export function writeJsonLine(stream, message) {
  if (stream && !stream.destroyed && stream.writable) {
    stream.write(`${JSON.stringify(message)}\n`);
  }
}
