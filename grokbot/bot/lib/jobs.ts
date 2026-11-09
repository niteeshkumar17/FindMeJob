import { alertTo, gmailAddress, maxSendsPerDay } from "./profile.js";
import { companyKey, sendsToday, type HuntState } from "./state.js";
import type { SendMode } from "./mail.js";

export type JobLead = {
  jobId: string;
  company: string;
  role: string;
  url: string;
  description: string;
  postText: string;
};

const TECH = /software|developer|engineer|sdet|quality|qa|python|react|frontend|front-end|backend|back-end|full[\s-]?stack|firmware|embedded|iot|typescript|golang|\bgo\b/i;
const SKIP_ROLE = /sales|marketing|recruiter|accountant|designer|human resources|\bhr\b|intern\b/i;

export async function findJobs(state: HuntState, mode: SendMode): Promise<JobLead[]> {
  const remaining = mode === "employer" ? maxSendsPerDay() - sendsToday(state) : 8;
  if (remaining <= 0) {
    return [];
  }
  const settled = await Promise.allSettled([fetchRemotive(), fetchRemoteOk(), fetchArbeitnow(), fetchHn()]);
  const seen = new Set<string>();
  const leads: JobLead[] = [];
  for (const job of settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []))) {
    if (leads.length >= remaining) {
      break;
    }
    if (!job || seen.has(job.jobId) || !keepJob(job, state, mode)) {
      continue;
    }
    seen.add(job.jobId);
    leads.push(job);
  }
  return leads;
}

function keepJob(job: JobLead, state: HuntState, mode: SendMode): boolean {
  if (!TECH.test(`${job.role} ${job.description}`) || SKIP_ROLE.test(job.role)) {
    return false;
  }
  if (payTooLow(job.description)) {
    return false;
  }
  if (state.blockedJobIds.includes(job.jobId)) {
    return false;
  }
  if (mode === "dry") {
    return !state.previewedJobIds.includes(job.jobId) && !state.dryRunLog.some((entry) => entry.jobId === job.jobId);
  }
  if (mode === "test") {
    return !state.testSentJobIds.includes(job.jobId);
  }
  const key = companyKey(job.company);
  if (state.sentJobIds.includes(job.jobId)) {
    return false;
  }
  if (key && state.contactedCompanies.includes(key)) {
    return false;
  }
  return true;
}

function payTooLow(text: string): boolean {
  const lpaRange = text.match(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*lpa/i);
  if (lpaRange && Number(lpaRange[2]) < 6) {
    return true;
  }
  const lpa = text.match(/(\d+(?:\.\d+)?)\s*lpa/i);
  if (lpa && Number(lpa[1]) < 6) {
    return true;
  }
  const monthly = text.match(/(?:₹|rs\.?|inr)\s*(\d{2,3})\s*k/i);
  if (monthly && Number(monthly[1]) < 50) {
    return true;
  }
  return false;
}

export function addressInPost(postText: string): string | undefined {
  const matches = postText.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  return matches.find((address) => {
    if (!postText.includes(address)) {
      return false;
    }
    const lower = address.toLowerCase();
    const own = new Set([gmailAddress(), alertTo().toLowerCase()].filter((item) => item.length > 0));
    return (
      !lower.endsWith("@example.com") &&
      !lower.includes("noreply") &&
      !lower.includes("no-reply") &&
      !lower.endsWith("@github.com") &&
      !own.has(lower)
    );
  });
}

async function fetchRemotive(): Promise<JobLead[]> {
  const data = await getJson<{ jobs?: RemotiveJob[] }>("https://remotive.com/api/remote-jobs?category=software-dev");
  return (data.jobs ?? []).flatMap((job) => {
    const lead = toLead("remotive", String(job.id), job.company_name, job.title, job.url, job.description);
    return lead ? [lead] : [];
  });
}

async function fetchRemoteOk(): Promise<JobLead[]> {
  const data = await getJson<RemoteOkJob[]>("https://remoteok.com/api", {
    "User-Agent": "grokbot-job-hunt",
  });
  return data.flatMap((job) => {
    if (!job.id || !job.position) {
      return [];
    }
    const lead = toLead("remoteok", String(job.id), job.company ?? "", job.position, job.url ?? job.apply_url ?? "", job.description ?? "");
    return lead ? [lead] : [];
  });
}

async function fetchArbeitnow(): Promise<JobLead[]> {
  const data = await getJson<{ data?: ArbeitnowJob[] }>("https://www.arbeitnow.com/api/job-board-api");
  return (data.data ?? []).flatMap((job) => {
    const lead = toLead("arbeitnow", job.slug, job.company_name, job.title, job.url, job.description);
    return lead ? [lead] : [];
  });
}

async function fetchHn(): Promise<JobLead[]> {
  const stories = await getJson<HnSearch>(
    "https://hn.algolia.com/api/v1/search?query=%22who%20is%20hiring%22&tags=story&hitsPerPage=1",
  );
  const story = stories.hits?.[0];
  if (!story) {
    return [];
  }
  const comments = await getJson<HnSearch>(
    `https://hn.algolia.com/api/v1/search?tags=comment,story_${story.objectID}&hitsPerPage=50`,
  );
  return (comments.hits ?? []).flatMap((hit) => {
    const lead = toLead(
      "hn",
      hit.objectID,
      companyFromComment(hit.comment_text ?? ""),
      firstLine(hit.comment_text ?? ""),
      hit.story_url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
      hit.comment_text ?? "",
    );
    return lead ? [lead] : [];
  });
}

function companyFromComment(text: string): string {
  const line = firstLine(text).replace(/\|/g, " ").trim();
  return line.slice(0, 80) || "Hacker News hiring";
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "Software engineer";
}

function toLead(source: string, id: string, company: string, role: string, url: string, description: string): JobLead | undefined {
  const plain = description.replace(/<[^>]+>/g, " ");
  const postText = `${url}\n${plain}`.slice(0, 20000);
  const targetEmail = addressInPost(postText);
  if (!targetEmail) {
    return undefined;
  }
  return {
    jobId: `${source}:${id}`,
    company: company || "Unknown",
    role: role || "Software engineer",
    url,
    description: plain.replace(/\s+/g, " ").slice(0, 1500),
    postText,
  };
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, {
    headers: { "User-Agent": "grokbot-job-hunt", ...headers },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    throw new Error(`Job fetch failed: ${response.status} ${url}`);
  }
  return (await response.json()) as T;
}

type RemotiveJob = { id: number; company_name: string; title: string; url: string; description: string };
type RemoteOkJob = { id?: number; company?: string; position?: string; description?: string; url?: string; apply_url?: string };
type ArbeitnowJob = { slug: string; company_name: string; title: string; url: string; description: string };
type HnSearch = { hits?: Array<{ objectID: string; comment_text?: string; story_url?: string }> };
