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

// Vite reloads this module while old streams may still be open. Share the
// registry so hot reload never installs competing signal handlers.
const shared = globalThis as typeof globalThis & {
	watchTailLiveStreams?: { closers: Set<StreamCloser>; listening: boolean };
};
const registry = (shared.watchTailLiveStreams ??= {
	closers: new Set<StreamCloser>(),
	listening: false,
});
const { closers } = registry;

/** Clean up streams without swallowing Node's default signal termination. */
function onSignal(signal: NodeJS.Signals): void {
	closeLiveStreams();
	if (process.listenerCount(signal) === 0) {
		// The once-listener has already removed itself. With no server shutdown
		// handler left, re-send the signal to restore Node's default termination.
		process.kill(process.pid, signal);
	}
}

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
 * The signal handlers are installed with the first stream and remain until
 * shutdown, even when all streams have already disconnected.
 */
export function registerLiveStream(close: StreamCloser): () => void {
	if (!registry.listening) {
		registry.listening = true;
		// Run and remove our handler before framework/exit hooks inspect listener
		// counts. In particular, signal-exit only terminates when it owns the
		// remaining listeners; a persistent cleanup listener makes it do nothing.
		process.prependOnceListener('SIGINT', onSignal);
		process.prependOnceListener('SIGTERM', onSignal);
	}
	closers.add(close);
	return () => {
		closers.delete(close);
	};
}
