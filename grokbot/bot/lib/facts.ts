import { identityText } from "./profile.js";

const GITHUB_USER = "niteeshkumar17";
const STORE_URL = "https://kalingastore.shop/";

export type FactSource = {
  ok: boolean;
  text: string;
  error?: string;
};

let cache: { at: number; source: FactSource } | undefined;

const STOP = new Set(
  `a an the and or but if then else when while of to for from in on at by with without
as is are was were be been being it its this that these those i me my we you your he she
they them their not no nor so than too very can will just into over after before about
between under again further once here there all any each few more most other some such
only own same than too very also please hello attached apply applying application role
company team work using used use per via across within during where which who whom what
how why because until while into onto off up down out than`.split(/\s+/),
);

export async function loadFacts(): Promise<FactSource> {
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) {
    return cache.source;
  }
  try {
    const [github, store] = await Promise.all([fetchGithub(), fetchStore()]);
    const text = [identityText(), github, store].join("\n\n");
    const source = { ok: true, text };
    cache = { at: Date.now(), source };
    return source;
  } catch (error) {
    const source = {
      ok: false,
      text: "",
      error: error instanceof Error ? error.message : String(error),
    };
    return source;
  }
}

export type Review = {
  ok: boolean;
  flags: string[];
};

export const RESTRICTED_VERBS = [
  "led",
  "architected",
  "managed",
  "owned",
  "lead",
  "leading",
  "oversaw",
  "spearheaded",
  "headed",
] as const;

const RESTRICTED = new Set<string>(RESTRICTED_VERBS);

/** Whole words in any case. The tokens LED and LEDs are the electronics exception. */
export function restrictedVerbs(resumeText: string): string[] {
  const found = new Set<string>();
  for (const match of resumeText.matchAll(/\b[A-Za-z]+\b/g)) {
    const token = match[0];
    if (token === "LED" || token === "LEDs") {
      continue;
    }
    const lower = token.toLowerCase();
    if (RESTRICTED.has(lower)) {
      found.add(lower);
    }
  }
  return RESTRICTED_VERBS.filter((verb) => found.has(verb));
}

export function reviewResume(resumeText: string, corpus: string): Review {
  const flags: string[] = [];
  const hay = corpus.toLowerCase();
  const words = resumeText.toLowerCase().match(/[a-z][a-z0-9+#]{1,}/g) ?? [];
  const seen = new Set<string>();
  const shortSkills = new Set(["go", "qa"]);
  for (const word of words) {
    if (seen.has(word) || STOP.has(word) || RESTRICTED.has(word)) {
      continue;
    }
    if (word.length < 3 && !shortSkills.has(word)) {
      continue;
    }
    seen.add(word);
    const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (!pattern.test(hay)) {
      flags.push(`word not in GitHub or the store: ${word}`);
    }
    if (flags.length >= 40) {
      break;
    }
  }
  const numbers = resumeText.match(/\d+(?:\.\d+)?%|\d{2,}(?:\.\d+)?/g) ?? [];
  for (const value of numbers) {
    const digits = value.replace("%", "");
    if (!corpus.includes(digits)) {
      flags.push(`number not in GitHub or the store: ${value}`);
    }
  }
  return { ok: flags.length === 0, flags };
}

const FALLBACK_REPOS: Array<{ name: string; branch: string; language: string }> = [
  { name: "MyAlgoTrade", branch: "main", language: "TypeScript" },
  { name: "CCTVtoGDrive", branch: "main", language: "Go" },
  { name: "Smart-Pumps", branch: "main", language: "Python" },
  { name: "Secure_Insta_Message", branch: "master", language: "Python" },
  { name: "Secure_Insta_Message_Flutter", branch: "main", language: "Dart" },
  { name: "esp", branch: "main", language: "C" },
  { name: "video_downloader", branch: "main", language: "Python" },
  { name: "Movie-Streaming", branch: "main", language: "JavaScript" },
  { name: "vr_notes", branch: "main", language: "JavaScript" },
];

async function fetchGithub(): Promise<string> {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "grokbot-job-hunt",
  };
  try {
    const user = await getJson<GithubUser>(`https://api.github.com/users/${GITHUB_USER}`, headers);
    const repos = await getJson<GithubRepo[]>(
      `https://api.github.com/users/${GITHUB_USER}/repos?per_page=100&sort=pushed`,
      headers,
    );
    const parts = [
      `GitHub login ${user.login}`,
      `GitHub name ${user.name ?? ""}`,
      `GitHub bio ${user.bio ?? ""}`,
      `GitHub blog ${user.blog ?? ""}`,
    ];
    for (const repo of repos.slice(0, 12)) {
      parts.push(
        [
          `repo ${repo.name}`,
          `description ${repo.description ?? ""}`,
          `homepage ${repo.homepage ?? ""}`,
          `language ${repo.language ?? ""}`,
        ].join("\n"),
      );
      const readme = await fetchRaw(repo.name, repo.default_branch || "main");
      if (readme) {
        parts.push(readme.slice(0, 8000));
      }
    }
    return parts.join("\n\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("403")) {
      throw error;
    }
    return fetchGithubRaw();
  }
}

async function fetchGithubRaw(): Promise<string> {
  const parts = ["GitHub login niteeshkumar17"];
  for (const repo of FALLBACK_REPOS) {
    parts.push(`repo ${repo.name} language ${repo.language}`);
    const readme = await fetchRaw(repo.name, repo.branch);
    if (readme) {
      parts.push(readme.slice(0, 8000));
    }
  }
  if (!parts.some((part) => part.startsWith("#") || part.length > 80)) {
    throw new Error("GitHub readmes were unavailable");
  }
  return parts.join("\n\n");
}

async function fetchRaw(name: string, branch: string): Promise<string> {
  for (const ref of [branch, branch === "main" ? "master" : "main"]) {
    const response = await fetch(
      `https://raw.githubusercontent.com/${GITHUB_USER}/${name}/${ref}/README.md`,
      { headers: { "User-Agent": "grokbot-job-hunt" } },
    );
    if (response.ok) {
      return response.text();
    }
  }
  return "";
}

async function fetchStore(): Promise<string> {
  const response = await fetch(STORE_URL, { headers: { "User-Agent": "grokbot-job-hunt" } });
  if (!response.ok) {
    throw new Error(`Store fetch failed: ${response.status}`);
  }
  const html = await response.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 40) {
    throw new Error("Store page had no visible text");
  }
  return `Store page ${STORE_URL}\n${text.slice(0, 8000)}`;
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub fetch failed: ${response.status} ${url}`);
  }
  return (await response.json()) as T;
}

type GithubUser = {
  login: string;
  name: string | null;
  bio: string | null;
  blog: string | null;
};

type GithubRepo = {
  name: string;
  full_name: string;
  description: string | null;
  homepage: string | null;
  language: string | null;
  default_branch: string;
};
