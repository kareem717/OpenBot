### Changed

- Remove the total limits for connectors, installed skills, and saved memories. Existing data stays available. Older clients keep their supported list sizes; updated clients load all entries.
- Keep desktop fork updates on a separate release feed so updates preserve these changes.

### Added

- Add an optional Linux network namespace for all OpenBot processes. It routes their traffic through a selected Tailscale exit node and preserves the VPS network route.
- **The forked macOS client needs manual installation because this build has no Developer ID signature.**
