### Fixed

- Native browser control supports Linux screenshot-only captures and text input. Window ownership, capture IDs,
  frame validation and permission checks stay in place.
- An external CDP connection selects its requested existing tab before browser input.
- Tasks can use native controls for their own browser tabs under the parent agent’s Computer Use permission.
- Self-hosted servers start a managed window manager on the private browser display for native input.
