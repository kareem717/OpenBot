/** The desktop fork has its own feed; the repository's default branch is another application. */
export const DESKTOP_RELEASES_URL = "https://github.com/kareem717/OpenBot/releases";
export const DESKTOP_RELEASE_FEED_URL = `${DESKTOP_RELEASES_URL}/download/desktop-latest/`;

/** Each payload is published once, before the moving feed can name it. */
export function desktopReleaseAssetUrl(version: string, asset: string): string {
  return `${DESKTOP_RELEASES_URL}/download/desktop-v${version}/${asset}`;
}
