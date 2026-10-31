import {
  cookieHeader,
  currentSession,
  INSTALL_COOKIE,
  nonce,
  privateJson,
  seal,
  type InstallIntent,
} from "../../../../lib/github-ingestion/session";
import { connection } from "next/server";
import {
  QuotaExceeded,
  sharedQuotas,
} from "../../../../lib/github-ingestion/quota-store";
import {
  installationSettingsUrl,
  installationsForUser,
} from "../../../../lib/github-ingestion/app";
export async function GET(request: Request) {
  await connection();
  const user = currentSession(request);
  if (!user) return privateJson({ error: "Connect GitHub first." }, 401);
  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug || !/^[A-Za-z0-9-]+$/.test(slug))
    return privateJson(
      { error: "GitHub App installation is unavailable." },
      503,
    );
  const requested = new URL(request.url).searchParams.get("installationId");
  if (
    requested !== null &&
    (!/^[1-9][0-9]*$/.test(requested) ||
      !Number.isSafeInteger(Number(requested)))
  )
    return privateJson({ error: "Installation is unavailable." }, 404);
  let settings: string | undefined;
  if (requested !== null) {
    try {
      const installation = (await installationsForUser(user)).find(
        (item) => item.id === Number(requested),
      );
      if (!installation)
        return privateJson({ error: "Installation is unavailable." }, 404);
      settings = installationSettingsUrl(installation);
    } catch {
      return privateJson(
        { error: "GitHub installation could not be verified. Retry later." },
        502,
      );
    }
  }
  try {
    sharedQuotas().reserve({
      scope: "installation_start",
      subject: user.id,
      limit: 5,
      windowMs: 900_000,
    });
  } catch (error) {
    if (error instanceof QuotaExceeded)
      return new Response(
        JSON.stringify({
          error: "Installation quota exceeded. Retry later.",
          retryAfter: error.retryAfterSeconds,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "private, no-store",
            "Retry-After": String(error.retryAfterSeconds),
          },
        },
      );
    throw error;
  }
  if (settings) {
    const intent: InstallIntent = {
      state: nonce(),
      userId: user.id,
      expiresAt: Date.now() + 600_000,
      installationId: Number(requested),
    };

    return new Response(null, {
      status: 302,
      headers: {
        Location: settings,
        "Set-Cookie": cookieHeader(INSTALL_COOKIE, seal(intent), 600),
        "Cache-Control": "private, no-store",
      },
    });
  }
  const intent: InstallIntent = {
    state: nonce(),
    userId: user.id,
    expiresAt: Date.now() + 600_000,
  };
  const url = new URL(`https://github.com/apps/${slug}/installations/new`);
  url.searchParams.set("state", intent.state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Set-Cookie": cookieHeader(INSTALL_COOKIE, seal(intent), 600),
      "Cache-Control": "private, no-store",
    },
  });
}
