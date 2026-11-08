### Fixed

- The fork workflow uses Kareem's repository as `origin` and the original repository as
  `upstream`. Checked changes are documented, merged and pushed to the fork's `main`, then
  deployed to the VPS and Mac. Each result is verified and reported separately.
- Production Cloudflare deployment, upstream runtime publication and mobile release
  announcements remain scoped to the original repository. A push to the fork's `main` can
  run CI without starting those upstream publication jobs. Private deployment receipts stay
  outside Git. These workflow and documentation changes do not change installed application code.
