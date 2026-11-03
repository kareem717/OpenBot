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
contents for a version already published. Both kinds of desktop release use `--latest=false`.

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

Fetch the required `nightly-labs/openbot` release and merge it into the desktop branch. Preserve
the capacity changes and the isolated feed addresses. Resolve conflicts in source, run the branch
workflow, and complete the upgrade audit before publishing the next numeric desktop version.
Do not point this branch at the repository-wide latest release, move the other application's
default branch, or publish desktop packages under its version tags.
