export type GitHubRepository = { owner: string; repo: string; canonicalUrl: string };

/** Deliberately narrow: no URL parser normalization of credentials, encoding, or paths. */
export function parsePublicGitHubUrl(input: string): GitHubRepository {
  if (typeof input !== "string" || input.length > 256 || !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(input)) {
    throw new Error("Enter a canonical public GitHub repository URL, such as https://github.com/owner/repository.");
  }
  const [, , , owner, repo] = input.split("/");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) || owner.includes("--") || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo) || repo.endsWith(".git") || repo.endsWith(".")) {
    throw new Error("GitHub owner or repository name is invalid.");
  }
  return { owner, repo, canonicalUrl: input };
}
