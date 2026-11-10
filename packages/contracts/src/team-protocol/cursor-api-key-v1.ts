// Frozen optional cursor-api-key-v1 marker.
//
// What it grants, recorded here because freezing it makes it permanent: nothing new on the wire. It
// tells a client that the host reads a Cursor key saved through the released `apiKeySet` route of
// providers-v1, v5 or v8, and gives it to the Cursor CLI as `CURSOR_API_KEY`. The key stays in
// OpenBot's key store, so `apiKeyState` and `apiKeyClear` answer as for any stored key. A saved key
// comes before a `CURSOR_API_KEY` in the host's own environment. An older host stores such a key and
// never reads it, so a client offers the key only when the host advertises this. The routes, their
// admin gate and their bounds stay as each released provider protocol defines them. Widening any of
// it needs a second capability string.
export const CURSOR_API_KEY_CAPABILITY = "cursor-api-key-v1";
