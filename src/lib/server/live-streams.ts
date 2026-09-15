/**
 * The open event streams of this server process.
 *
 * A live tail is a connection that never finishes on its own - someone is
 * watching a group - and adapter-node shuts down gracefully: on SIGINT/SIGTERM
 * it stops accepting connections and *waits for the in-flight ones to finish*,
 * force-closing them only after `SHUTDOWN_TIMEOUT` (thirty seconds by default).
 * A server with a browser attached therefore took half a minute to stop, which
 * reads exactly like "Ctrl+C does not stop the server".
 *
 * Registering every stream here lets a signal end them at once, so the graceful
 * shutdown completes in the same tick and the process exits immediately. The
 * same registry covers the Vite dev server, which runs the app in one process.
 */

/** Ends one open stream: writes its `end` frame and closes the connection. */
type StreamCloser = () => void;

const closers = new Set<StreamCloser>();
let listening = false;

/** Ends every open stream, and reports how many were open. */
export function closeLiveStreams(): number {
	const count = closers.size;
	// Iterating the set directly is safe: a closer may delete its own entry (that
	// is what its unregister does), and `Set` iteration skips what was removed.
	for (const close of closers) {
		try {
			close();
		} catch {
			// A stream that is already gone cannot be closed again.
		}
	}
	closers.clear();
	return count;
}

/** How many streams are open right now. */
export function liveStreamCount(): number {
	return closers.size;
}

/**
 * Registers an open stream, and returns the function that unregisters it.
 *
 * The signal handlers are installed with the first stream and stay installed,
 * so a server that has served a tail stops promptly for the rest of its life.
 */
export function registerLiveStream(close: StreamCloser): () => void {
	if (!listening) {
		listening = true;
		// Node keeps the process alive for a listener, so this is deliberately
		// `on` rather than `once`: the same handler must work for every stream.
		process.on('SIGINT', () => closeLiveStreams());
		process.on('SIGTERM', () => closeLiveStreams());
	}
	closers.add(close);
	return () => {
		closers.delete(close);
	};
}
