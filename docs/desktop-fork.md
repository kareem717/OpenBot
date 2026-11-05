# Desktop fork updates

The `codex/remove-capacity-limits` branch contains the Electron desktop application. The default
branch of `kareem717/OpenBot` contains a different application. Keep the histories and update feeds
separate.

## Release addresses

| Address | Purpose |
| --- | --- |
| `desktop-v<version>` GitHub release | Immutable desktop packages and their manifests |
| `desktop-latest` GitHub release | Moving Linux update manifest only |
| Repository-wide latest release | The other application; the desktop branch does not read or change it |

The installed desktop package uses the generic feed at
`https://github.com/kareem717/OpenBot/releases/download/desktop-latest/`. The Linux installer,
hosted updater, and release status check use that same feed. A manifest names its complete,
versioned download address, for example
`https://github.com/kareem717/OpenBot/releases/download/desktop-v0.60.1/OpenBot-0.60.1-x86_64.AppImage`.

The publisher uploads the immutable packages first. It advances the moving manifest only after
both native builds pass and the package hashes match. A failed or interrupted download therefore
keeps referring to the same immutable package. A feed promotion rejects an older version or changed
contents for a version already published. Both kinds of desktop release use `--prerelease --latest=false`. Their numeric app versions
remain normal update versions because the desktop reads the explicit generic feed.

## Build and check

A push to the desktop branch runs `.github/workflows/desktop-fork.yml`. It checks the affected
TypeScript projects, runs the real-service capacity and feed checks, and builds these artifacts:

- `desktop-linux-x64`: the self-hosted server AppImage and Linux update manifest.
- `desktop-macos-arm64`: the local-install client ZIP, DMG, and manifest.

These branch builds are GitHub Actions artifacts. They publish no GitHub release and change no
installed application. Package checks run the packaged application, check its resources, update
source, archive integrity, and Electron sandbox fuses. Builds use the repository's pinned Node and
Bun versions and its existing native-runtime preparation scripts.

Keep focused checks local. Full native builds run in GitHub Actions.

## Install the checked build

Download both artifacts from the same successful workflow run. The server and client both need
the capacity changes: an older client can still reject the larger list or disable its controls.

On a Linux server, verify the AppImage against its `latest-linux.yml` SHA-512 before extracting it.
The initial fork build can have the same version as the installed upstream build. Extract it into
a temporary directory, then run its `resources/hosting/openbot-server-setup` script as root. That
script preserves the existing service user, data directory, account-service override, and display
size. It refuses a lower version. Stop and start the service through that setup script; do not
replace `app.asar` under a running process.

For an extracted and verified build in `squashfs-root`, the initial install command is:

```sh
sudo bash "$PWD/squashfs-root/resources/hosting/openbot-server-setup" "" "$PWD/squashfs-root"
```

On an Apple silicon Mac, quit OpenBot and install the checked DMG's complete application bundle.
Keep the existing application-data folder. This client is unsigned for distribution and is not
notarized. The operating system can require the user to allow its first launch. Do not edit the
archive of the upstream signed application: that breaks its archive integrity and signature.

The unsigned Mac client is a manual installation. The publisher does not place `latest-mac.yml`
on the moving feed. A signed, notarized Mac release and its signing verification are required
before automatic Mac updates can be offered. Until then, install the checked client artifact for
each desktop release. The fork client does not fall back to the upstream update feed.

## Publish an update

Before a version change or tag, complete the repository's release-upgrade-safety audit. Keep the
application version numeric `x.y.z`; hosted installation does not accept a prerelease suffix.
Never deploy an older source schema over a database opened by a newer release.

After review and verification, push a tag named `desktop-v<package.json version>` on the desktop
branch commit. The same workflow builds both native artifacts. Its publish job then creates that
namespaced release and advances the isolated Linux feed. Versioned release contents cannot be
replaced. Re-running a failed publish job can reuse them only when its checksum list is identical.

After the first fork release is installed, the server's existing update timer and update command
download only the fork feed. Each new package carries the fork's updater and install scripts, so
an update retains that source. The source changes are Git commits on the desktop branch, not a
local archive patch.

## Bring in upstream changes

Keep desktop fixes as source commits on the desktop branch. Do not patch installed archives or
store fixes only in an agent's workspace instructions. A full package update must contain the same
source changes as its tag.

After an upstream merge or rebase, keep these checks in `desktop-fork.yml`:

- `scripts/plan-continuation-e2e.ts`: continue a short unfinished next-step answer or commentary,
  with bounded retries and no continuation while waiting for the user.
- `scripts/browser-user-control-e2e.ts`: tab-list and status reads return while a person holds a
  tab; page reads and mutations still wait.
- `bun run test:browser-cdp`: attach the real `agent-browser` CLI to the existing tab, keep its
  session, limit target access, redact secrets, and revoke external access for user control.
- `scripts/browser-smoke.ts --scenario=secret-handoff`: saved authenticator fills work without an
  autocomplete marker when the numeric field has an explicit OTP identity.
- `scripts/browser-native-control-e2e.ts`: use real OS input in the same tab between CDP sessions;
  keep the document and sign-in, exclude CDP during native control, and preserve permission gates.
- `scripts/browser-native-task-permission-e2e.ts`: allow an enabled agent's task to use its own
  native browser, keep general desktop MCP tools out of tasks, and honor parent permission revocation.

Resolve conflicts in the owning source modules and keep these behavior checks. Preserve the
credential-source instructions in `agent/developer-instructions.ts` and `agent/tool-guidance.ts`:
user-supplied file or API credentials can be read and entered by a local script without printing
their values. A successful rebase alone does not verify that these behaviors remain.
Keep the native control port, private driver display selection, and CDP lease exclusion together.
On a server, the browser and general Computer Use can use different displays; the native browser
driver must use Electron's display and must not be published as a general provider MCP server.

Fetch the required `nightly-labs/openbot` release and merge it into the desktop branch. Preserve
the capacity changes and the isolated feed addresses. Resolve conflicts in source, run the branch
workflow, and complete the upgrade audit before publishing the next numeric desktop version.
Do not point this branch at the repository-wide latest release, move the other application's
default branch, or publish desktop packages under its version tags.

## Recover a queued Mac build

For `desktop-v0.60.12`, the recovery workflow uses a standard macOS 15 ARM64 runner.
It checks out the exact release tag and requires source commit
`01d437758958c87fabec92bfc5162c4f4e219a3a` before building. It keeps the package, launch,
runtime, archive and manifest checks. The artifact includes `recovery-source.json`.
The workflow uploads artifacts only. If recovery supplies the Mac package, record both the
Linux/source workflow and the recovery workflow in the release evidence before publication.
Use the tagged metadata tools; do not copy tools from a later branch into this build.

The initial recovery built the exact `desktop-v0.60.1` source
on a standard macOS 26 ARM64 runner. It checked the source commit before building.
The packaged app then passed the same archive, fuse, runtime, and launch checks.
After that build, the workflow applied the branch's corrected manifest tooling:
macOS manifests contain both ZIP and DMG entries, each with a verified digest.
This changes release metadata tooling only. The tagged application source stays
the source of the package. Failed runs retain diagnostic packages separately.

The original Linux package and the recovered Mac package can form one release
only after both native package checks pass and their source commit matches.
Record both run links in the release notes, verify all hashes, and use the same
immutable-payload and monotonic-feed checks as the normal publisher. The normal
workflow also uses macOS 26 for later releases.

The initial `desktop-latest` tag is bootstrapped with the maintainer's GitHub access.
A workflow token can upload a release for an existing tag but can lack permission
to create this first tag from a branch that changes workflow files. Later releases
reuse that feed tag and replace only its Linux manifest.
