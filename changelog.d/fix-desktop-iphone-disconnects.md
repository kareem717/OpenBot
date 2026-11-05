### Fixed

- Prevent browser cookies from making the secret redaction pattern too large. Keep all registered secrets protected while reducing connection stalls and crashes.
- Retry a lost relay credential refresh before the old credentials expire.
- Recognize labelled verification code fields for saved authenticator codes. Check the labels again before secure entry.
- Keep saved login fill available after native browser navigation, and recover the sign-in view after failed secret entry.
