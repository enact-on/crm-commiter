/**
 * CRM commit logger — called by .github/workflows/crm-commit-log.yml
 *
 * Reads commit data from git, analyzes it with an LLM via OpenRouter,
 * then POSTs the result to the CRM /api/projects/commit endpoint.
 * If a NextAI URL + secret are configured, also calls the NextAI
 * process-commit endpoint to auto-update task checklists from the commit.
 *
 * Required env vars (set as GitHub secrets):
 *   OPENROUTER_API_KEY
 *   CRM_API_TOKEN
 *
 * Optional env vars:
 *   OPENROUTER_MODEL      — defaults to deepseek/deepseek-v4-pro
 *   NEXTAI_URL            — base URL of the NextAI app (e.g. https://nextai.enacton.com)
 *   NEXTAI_COMMIT_SECRET  — bearer token for the NextAI process-commit endpoint
 */

"use strict";

const { execSync } = require("child_process");

const CRM_BASE_URL   = "https://crm.enacton.com";
const DEFAULT_MODEL  = "deepseek/deepseek-v4-pro";
const MAX_DIFF_CHARS = 400_000; // ~100k tokens, leaves headroom in 120k ctx window

// ── helpers ──────────────────────────────────────────────────────────────────

function git(...args) {
  try {
    return execSync(`git ${args.join(" ")}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return "";
  }
}

async function postJSON(url, payload, headers) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return JSON.parse(text);
}

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
  // ── collect commit data ───────────────────────────────────────────────────

  const sha           = process.env.GITHUB_SHA;
  const repo          = process.env.GITHUB_REPOSITORY;
  const actor         = process.env.GITHUB_ACTOR;
  const ref           = process.env.GITHUB_REF || "";
  const branch        = ref.replace(/^refs\/heads\//, "");
  const commitMsg     = git("log -1 --format=%B").trim();
  const commitDate    = git("log -1 --format=%cI").trim();
  const authorEmail   = git("log -1 --format=%ae").trim();
  const parentHashes  = git("log -1 --format=%P").trim().split(/\s+/).filter(Boolean);
  const isMergeCommit = parentHashes.length >= 2;

  // Determine branch context
  const isMainBranch    = ["master", "main", "production", "prod"].includes(branch);
  const isStagingBranch = ["staging", "develop", "dev", "test"].includes(branch);
  const isFeatureBranch = !isMainBranch && !isStagingBranch && branch !== "";

  // Build branch-flow context for the AI
  let branchContext = "";
  if (isFeatureBranch) {
    branchContext = `This is a development commit on feature branch "${branch}". ` +
      `It represents ongoing development work that has not yet been merged to staging or master.`;
  } else if (isStagingBranch) {
    if (isMergeCommit) {
      branchContext = `This is a MERGE COMMIT landing on the staging branch "${branch}". ` +
        `It means feature development was completed earlier (likely days/weeks ago) and is now being ` +
        `promoted to the staging environment for testing. The actual coding happened in prior commits ` +
        `on the feature branch; this merge is the integration/promotion event.`;
    } else {
      branchContext = `This is a direct commit on the staging branch "${branch}".`;
    }
  } else if (isMainBranch) {
    if (isMergeCommit) {
      branchContext = `This is a MERGE COMMIT landing on the MAIN/PRODUCTION branch "${branch}". ` +
        `It means code that was tested on staging has now been promoted to production. ` +
        `The feature development happened earlier (on a feature branch and/or staging), and this commit ` +
        `represents the final promotion to the main branch. When summarizing, note that the actual ` +
        `development was done in prior commits — this merge is the delivery-to-production event.`;
    } else {
      branchContext = `This is a direct commit on the MAIN/PRODUCTION branch "${branch}".`;
    }
  } else if (branch) {
    branchContext = `This commit is on branch "${branch}".`;
  }

  // For merge commits, list the commits that were merged (the "feature" side)
  let mergedCommitsContext = "";
  if (isMergeCommit) {
    try {
      // The second parent (^2) is the branch being merged
      const mergedRange = `${sha}^1..${sha}^2`;
      const mergedLog = git("log", mergedRange, "--oneline", "--format=%ad %h %s", "--date=short");
      if (mergedLog.trim()) {
        mergedCommitsContext = `\nCommits included in this merge (from the merged branch):\n${mergedLog.trim()}`;
      }
    } catch {
      // If ^2 resolution fails, skip
    }

    // Detect source branch from merge commit message
    const mergeBranchMatch = commitMsg.match(/Merge branch '([^']+)'/);
    const mergePRMatch = commitMsg.match(/Merge pull request #(\d+) from ([^\/\s]+)\/([^\s]+)/);
    if (mergeBranchMatch) {
      mergedCommitsContext += `\nDetected merged branch: ${mergeBranchMatch[1]}`;
    } else if (mergePRMatch) {
      mergedCommitsContext += `\nDetected PR #${mergePRMatch[1]} from branch: ${mergePRMatch[3]}`;
    }
  }

  const stat = git("diff --stat HEAD~1 HEAD") || git("show --stat --format= HEAD");

  let diff = git("diff HEAD~1 HEAD") || git("show --format= HEAD");
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS) + "\n\n... [diff truncated at 400000 chars]";
  }

  // ── prompts ───────────────────────────────────────────────────────────────

  const systemPrompt = `\
You are an expert software engineer and code reviewer embedded in a project management system.
Your job is to analyze git commits and produce structured, high-signal assessments that help
engineering managers and team leads understand what changed, why it matters, and how well it
was done — without them having to read the diff themselves.

Rules:
- Be specific and technical. Name the files, functions, or systems that changed.
- Do not pad. Every sentence must add information not obvious from the commit message alone.
- Infer intent from the diff when the commit message is vague or missing.
- When given branch/merge context, reflect the development timeline: feature work happens first,
  then staging merges, then production merges. A merge to master today may represent work that
  was done days or weeks ago on a feature branch.
- Respond with ONLY a valid JSON object. No markdown fences, no prose, no extra keys.`;

  const userPrompt = `\
Analyze the following git commit.

Commit message : ${commitMsg}
Author         : ${actor} <${authorEmail}>
Repository     : ${repo}
Commit SHA     : ${sha}
Branch         : ${branch || "(unknown)"}
Commit date    : ${commitDate}
Merge commit   : ${isMergeCommit ? "YES" : "no"}

--- Branch / timeline context ---
${branchContext}${mergedCommitsContext}

--- Changed files (stat) ---
${stat}
--- Full diff ---
${diff}`;

  // ── structured output schema ──────────────────────────────────────────────

  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "commit_analysis",
      strict: true,
      schema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description:
              "3-4 sentences covering: (1) what changed technically, " +
              "(2) why it was needed or what problem it solves, " +
              "(3) any architectural impact or risk worth flagging. " +
              "If this is a merge to main/staging, note that the actual development " +
              "happened earlier on a feature branch and this is the promotion event.",
          },
          quality: {
            type: "string",
            enum: ["excellent", "good", "needs-improvement", "poor"],
            description:
              "excellent=atomic scope, clear message, clean code; " +
              "good=sensible change, minor issues; " +
              "needs-improvement=vague message, mixed concerns, leftover TODOs; " +
              "poor=no message, massive unrelated changes, broken logic.",
          },
          work_items: {
            type: "array",
            description:
              "Discrete units of work visible in the diff. Each item is a single " +
              "feature, fix, refactor, or configuration change. Keep descriptions " +
              "concise (one sentence, plain English) and use past tense. " +
              "Skip trivial changes (comment typos, formatting-only). " +
              "Max 8 items. For merge commits to staging/main, derive items from " +
              "the feature branch commits that were merged.",
            items: {
              type: "object",
              properties: {
                description: {
                  type: "string",
                  description: "One-sentence plain-English description of the work done.",
                },
                completion_status: {
                  type: "string",
                  enum: ["completed", "in_progress", "not_applicable"],
                  description:
                    "completed=feature/fix is fully done and merged; " +
                    "in_progress=partial implementation, scaffold, or WIP code; " +
                    "not_applicable=tooling/config/docs not tied to a task.",
                },
                keywords: {
                  type: "array",
                  description: "3-6 searchable keywords that would appear in a task title for this work.",
                  items: { type: "string" },
                },
              },
              required: ["description", "completion_status", "keywords"],
              additionalProperties: false,
            },
          },
        },
        required: ["summary", "quality", "work_items"],
        additionalProperties: false,
      },
    },
  };

  // ── call OpenRouter ───────────────────────────────────────────────────────

  const orKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;

  console.log(`[openrouter] model=${model}  diff_chars=${diff.length}  merge=${isMergeCommit}  branch=${branch}`);

  const orResult = await postJSON(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model,
      max_tokens: 1024,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      response_format: responseFormat,
    },
    {
      Authorization: `Bearer ${orKey}`,
      "HTTP-Referer": `https://github.com/${repo}`,
      "X-Title": "CRM Commit Logger",
    }
  );

  // response_format: json_schema guarantees valid JSON — no parsing fallback needed
  const { summary = "", quality = "good", work_items = [] } = JSON.parse(orResult.choices[0].message.content);

  console.log(`[analysis]   quality=${quality}`);
  console.log(`[analysis]   summary=${summary}`);
  console.log(`[analysis]   work_items=${work_items.length}`);

  // ── POST to CRM ───────────────────────────────────────────────────────────

  const crmResult = await postJSON(
    `${CRM_BASE_URL.replace(/\/$/, "")}/api/projects/commit`,
    {
      repo,
      commit_hash:     sha,
      github_username: actor,
      commit_date:     commitDate,
      changes:         stat.slice(0, 2000),
      summary,
      quality,
    },
    { authtoken: process.env.CRM_API_TOKEN }
  );

  console.log(`[crm] logged → id=${crmResult.id}  projectid=${crmResult.projectid}  staffid=${crmResult.staffid}`);

  // ── Call NextAI process-commit (if configured) ────────────────────────────

  const nextaiUrl    = process.env.NEXTAI_URL;
  const nextaiSecret = process.env.NEXTAI_COMMIT_SECRET;
  const projectId    = crmResult.projectid;
  const staffId      = crmResult.staffid;

  if (nextaiUrl && nextaiSecret && projectId && staffId && work_items.length > 0) {
    try {
      const nextaiResult = await postJSON(
        `${nextaiUrl.replace(/\/$/, "")}/api/projects/${projectId}/process-commit`,
        {
          commitHash:  sha,
          summary,
          workItems:   work_items,
          staffId,
          commitDate,
          repo,
        },
        { Authorization: `Bearer ${nextaiSecret}` }
      );
      console.log(`[nextai] processed → updates=${nextaiResult.updates?.length ?? 0}`);
    } catch (err) {
      // Non-fatal: commit is already logged; checklist update failure is acceptable
      console.warn(`[nextai] process-commit failed (non-fatal): ${err.message}`);
    }
  } else if (nextaiUrl && !nextaiSecret) {
    console.warn("[nextai] NEXTAI_COMMIT_SECRET is not set — skipping task checklist update");
  }
})();
