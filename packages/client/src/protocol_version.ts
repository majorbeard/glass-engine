// The wire-contract major this client speaks. It must equal the engine's
// protocol version (docs/protocol.md, "Versioning"): the client refuses any
// other, on session creation and on every connection's first message.
export const SUPPORTED_PROTOCOL_VERSION = 3;

/** The message a client fails with when it and the engine speak different protocol versions. */
export function protocolMismatchMessage(engineVersion: number): string {
  return `Glass speaks protocol v${engineVersion}, but this client speaks v${SUPPORTED_PROTOCOL_VERSION}: use the @glass/client that matches the engine`;
}
