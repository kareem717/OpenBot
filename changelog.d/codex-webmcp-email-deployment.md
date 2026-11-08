### Fixed

- Managed browser tabs now expose native WebMCP. OpenPencil and other sites that support
  `document.modelContext` can register their tools without a user changing `chrome://flags`.
  The feature applies to normal tabs, popups, and restored tabs. The application's own
  renderer keeps its default feature set. Sites retain their own Off, Inspect, and Edit
  settings; this change does not enable a site's editing access automatically.

- Agents now distinguish an email verification code from a challenge that requires the
  user. For a requested task, they can use the user's authorized connected mailbox,
  including Gmail through Composio, as a credential source. They enter the matching current
  code through the existing protected local-script path and verify the resulting page.
  They must not print the code, include its literal value in provider tool arguments,
  or reuse an unrelated message. Routine guidance permits the same supported path.
  An already approved payment can use an email-code step; a bank-app approval, unavailable
  credential source, or a policy refusal still requires the appropriate input or report.
  Mailbox access does not approve another purchase.

- The native browser session E2E fixture checks WebMCP registration, discovery, execution,
  and removal, plus popup and restored-tab support. It also checks that browser pages
  have no Node or application bridge and retain sandboxing, context isolation, and web
  security. Its existing cookie, storage, profile, and task ownership checks remain.
  No database schema or released Team API protocol changes are required. Applying the
  main-process change requires restarting the host application. Existing private repairs,
  browser profiles, tabs, credentials, and database files must be preserved during installation.
