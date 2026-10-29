# GitHub App connection and private repository scans

Create a **dedicated CodeArchaeologist GitHub App**. Set repository permissions to **Contents: Read-only** and **Metadata: Read-only**. Request no write permissions. Enable user authorization. Configure the user authorization callback URL as `https://YOUR-ORIGIN/api/github-app/callback` and the installation setup URL as `https://YOUR-ORIGIN/api/github-app/install/callback`. For local development, use `http://localhost:3000` consistently in both URLs and `GITHUB_APP_ORIGIN`. Install the app for **selected repositories** when possible.

The browser user sign-in proves the GitHub account identity. Installation selection grants the app access to repositories. The server lists installations and repositories using the user's short-lived GitHub App user token, then creates a repository-scoped installation token for acquisition. A browser-supplied installation or repository ID is never trusted by itself. The installation callback does not grant access; the server checks GitHub's current repository list at job creation, before acquisition, after scanning, and before private artifact retrieval.

## Configuration

Set the server-only variables listed in `.env.example`: `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SESSION_SECRET`, and `GITHUB_APP_ORIGIN`. Keep the private key and client secret in ignored local secrets or a production secret store. Do not put them in browser variables. The app private key can be supplied as a PEM string with literal `\n` separators. Use a distinct 32-byte-or-longer random session secret. Serve production over HTTPS.

Docker remains required, as described in [GitHub ingestion](github-ingestion.md). The installation token is used only by the acquisition process and never passed to the Docker scanner. No repository code runs, and no source is sent to a model. The existing public URL flow and deployment access key remain separate.

The session cookie contains an opaque handle only; user and installation tokens stay in process memory. Sessions expire after eight hours or on logout. Process restart logs users out and drops in-flight jobs. GitHub token expiration or revocation produces a reconnect error. There is no token refresh or webhook-driven immediate revocation in this phase; authorization is checked when each private job or artifact is accessed. Already downloaded graph data in a user's browser cannot be remotely erased after a GitHub permission change; users should close shared browser sessions and disconnect. A single-process deployment is required for the in-memory session and job stores. Browser downloads are controlled by the authorized user and cannot be revoked once saved.

## Manual acceptance

1. Configure the App and Docker on the server; restart it. Open `/` in a fresh browser and choose **Connect GitHub**. Verify GitHub redirects to `/api/github-app/callback`, then back to `/` without a token in the URL or browser storage.
2. Choose **Authorize repositories**, install for one private repository, return to `/`, and refresh repositories. Verify its owner, name, private status, and installation ID are shown. With multiple installations, verify each authorized repository appears under the correct installation.
3. Select the private repository and start analysis. Observe the real job stages. When ready, verify the graph loads, modules and evidence are usable, and both artifacts download. Confirm source references remain relative paths.
4. Sign in as a second GitHub user without repository access. Verify the private repository is absent, its numeric IDs cannot create a scan, and its job status and artifacts return 404 even if the job ID is known.
5. Remove repository access or uninstall the App. Refresh the connection and try a new scan; it must fail. Try downloading an existing private artifact; it must be unavailable. Reinstall and reconnect, then retry.
6. Cancel a running job. Verify it stops, artifacts are unavailable, and temporary source directories are removed. Check Docker has no residual scanner container and no Docker socket was mounted into the scanner.
7. Disconnect. Verify the session is gone and the in-browser graph is cleared. Reopen a fresh browser and confirm no private graph or artifacts appear without authorization.
8. Exercise the existing public URL, browser directory, and JSON import paths. They must still work independently.
