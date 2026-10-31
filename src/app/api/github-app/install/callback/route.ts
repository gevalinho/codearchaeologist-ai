import {
  cookieHeader,
  cookieValue,
  currentSession,
  INSTALL_COOKIE,
  privateJson,
  unseal,
  type InstallIntent,
} from "../../../../../lib/github-ingestion/session";
import { connection } from "next/server";
import { installationsForUser } from "../../../../../lib/github-ingestion/app";
export async function GET(request: Request) {
  await connection();
  const user = currentSession(request),
    intent = unseal<InstallIntent>(cookieValue(request, INSTALL_COOKIE));
  const url = new URL(request.url),
    state = url.searchParams.get("state");
  if (!user)
    return privateJson(
      { error: "Invalid installation return. Reconnect and try again." },
      401,
    );
  const installationId = url.searchParams.get("installation_id");

  const validIntent =
    !!intent &&
    intent.userId === user.id &&
    intent.expiresAt > Date.now() &&
    /^[A-Za-z0-9_-]{43}$/.test(intent.state);

  if (!validIntent) {
    return privateJson(
      { error: "Invalid installation return. Reconnect and try again." },
      401,
    );
  }

  if (state !== null && state !== intent.state) {
    return privateJson(
      { error: "Invalid installation return. Reconnect and try again." },
      401,
    );
  }

  if (
    intent.installationId !== undefined &&
    (installationId === null ||
      Number(installationId) !== intent.installationId)
  ) {
    return privateJson(
      { error: "Installation does not match the requested installation." },
      401,
    );
  }
  if (installationId !== null) {
    if (
      !/^[1-9][0-9]*$/.test(installationId) ||
      !Number.isSafeInteger(Number(installationId))
    )
      return privateJson(
        { error: "Invalid installation return. Reconnect and try again." },
        401,
      );
    try {
      if (
        !(await installationsForUser(user)).some(
          (item) => item.id === Number(installationId),
        )
      )
        return privateJson(
          { error: "Invalid installation return. Reconnect and try again." },
          401,
        );
    } catch {
      return privateJson(
        { error: "GitHub installation could not be verified. Retry later." },
        502,
      );
    }
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/?github_connection=updated",
      "Set-Cookie": cookieHeader(INSTALL_COOKIE, "", 0),
      "Cache-Control": "private, no-store",
    },
  });
}
