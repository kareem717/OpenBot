### Changed

- Check side-thread sign-in cards in an isolated desktop package with a local test account and OAuth service. Verify that Continue keeps the draft and stays in its branch.
- Use the workflow's read-only GitHub token for runtime metadata downloads to reduce failures from unauthenticated API limits.
- Run Linux card checks with a private keyring and a local test browser, without user accounts or external sign-in.
