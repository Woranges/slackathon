// Shared between features/procore-issue-intake/ and features/knowledge-agent/
// (check_for_contradictions) — kept here rather than inside either feature
// folder since both genuinely need this same Procore MCP connection. Don't
// build the MCP protocol layer from scratch — use one of, in order of preference:
//   1. Procore's own official MCP setup (developers.procore.com/documentation/procore-ai-edge-mcp-setup)
//   2. Pipedream's hosted MCP endpoint (mcp.pipedream.com/app/procore)
//   3. A self-hosted community MCP server, only after reading its source —
//      it will hold live Procore OAuth credentials.
// Whichever is used, point PROCORE_MCP_URL (and PROCORE_MCP_TOKEN, if the
// chosen option needs a bearer token) at it in .env.

const PROCORE_MCP_URL = process.env.PROCORE_MCP_URL;
const PROCORE_MCP_TOKEN = process.env.PROCORE_MCP_TOKEN;

/**
 * Build the Procore MCP server config for agent.js's `mcpServers` list.
 * Returns null when not configured, so callers can omit it conditionally
 * (mirrors how the Slack MCP server is only added when a user token exists).
 * @returns {import('../../lib/llm/gemini.js').McpServerConfig | null}
 */
export function getProcoreMcpServerConfig() {
  if (!PROCORE_MCP_URL) return null;

  return {
    name: 'procore',
    url: PROCORE_MCP_URL,
    ...(PROCORE_MCP_TOKEN && { headers: { Authorization: `Bearer ${PROCORE_MCP_TOKEN}` } }),
  };
}

// ---------------------------------------------------------------------------
// Procore REST client (developer sandbox path).
//
// The write-back for issue-intake talks to Procore's REST API directly rather
// than the MCP config above: we chose the free developer sandbox, which is a
// plain OAuth2 + HTTPS API. Auth uses the *client-credentials* grant (a
// server-to-server "Data Connection" app — no user redirect), so no 3-legged
// OAuth flow is needed.
//
// Env is read inside the functions (not at module load) so it can be set/changed
// at runtime and unit-tested. Everything degrades gracefully: when the vars
// aren't set, isProcoreConfigured() is false and callers skip the write.
//
// VERIFIED against a live developer sandbox on 2026-07-10: the client-credentials
// token grant, the RFI create endpoint, and the payload shape below all work.
// Payload must use `question` (singular object) and a non-empty `assignee_ids`
// (resolved via resolveAssigneeIds); the create response returns `link` + `id`.

/**
 * @returns {{ baseUrl?: string, authUrl?: string, clientId?: string, clientSecret?: string, companyId?: string, projectId?: string }}
 */
function procoreEnv() {
  return {
    baseUrl: process.env.PROCORE_BASE_URL, // e.g. https://sandbox.procore.com
    authUrl: process.env.PROCORE_AUTH_URL, // e.g. https://login-sandbox.procore.com/oauth/token
    clientId: process.env.PROCORE_CLIENT_ID,
    clientSecret: process.env.PROCORE_CLIENT_SECRET,
    companyId: process.env.PROCORE_COMPANY_ID,
    projectId: process.env.PROCORE_PROJECT_ID,
  };
}

/**
 * True when every var needed to create an RFI is present.
 * @returns {boolean}
 */
export function isProcoreConfigured() {
  const e = procoreEnv();
  return Boolean(e.baseUrl && e.clientId && e.clientSecret && e.companyId && e.projectId);
}

/**
 * Map a structured issue record to a Procore RFI create payload. Pure — no I/O.
 * Verified against the live sandbox: the create endpoint requires `question`
 * (singular object, not `questions[]`) and a non-empty `assignee_ids`.
 * @param {import('../../features/procore-issue-intake/issue-record.js').IssueRecord} record
 * @param {number[]} [assigneeIds] - Procore project user ids to assign the RFI to.
 * @returns {Record<string, unknown>}
 */
export function buildRfiPayload(record, assigneeIds = []) {
  const isSafety = record.reportType === 'safety';
  const lines = [
    record.description,
    '',
    `Reported by: ${record.reporter.name} (${record.reporter.phone})`,
    record.siteName || record.siteId ? `Site: ${record.siteName ?? record.siteId}` : null,
    isSafety && record.severity ? `Severity: ${record.severity}` : null,
    !isSafety && record.specReference ? `Reference: ${record.specReference}` : null,
    record.geotag ? `Location: ${record.geotag.lat}, ${record.geotag.lng}` : null,
    // The photo is uploaded as a real RFI attachment (see createProcoreRfi), not
    // a body link — a raw Twilio media URL is auth-protected and unopenable.
    `Reported at: ${record.timestamp}`,
  ].filter((l) => l !== null);

  return {
    rfi: {
      // Safety reports get a SAFETY-prefixed subject so they're triageable in
      // Procore's RFI list. (Structured priority/due_date are a follow-up — they
      // need verifying against the live API before we risk a 400 on the create.)
      subject: isSafety ? `SAFETY: ${record.area}` : `Field issue: ${record.area}`,
      assignee_ids: assigneeIds,
      question: { body: lines.join('\n') },
    },
  };
}

/** @type {{ accessToken: string, expiresAt: number } | null} */
let cachedToken = null;

/**
 * Fetch (and briefly cache) an access token via the client-credentials grant.
 * @returns {Promise<string>}
 */
async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }
  const e = procoreEnv();
  const authUrl = e.authUrl ?? `${e.baseUrl}/oauth/token`;
  const res = await fetch(authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: e.clientId,
      client_secret: e.clientSecret,
    }),
  });
  if (!res.ok) {
    throw new Error(`Procore auth failed: ${res.status} ${await res.text()}`);
  }
  const json = /** @type {{ access_token: string, expires_in?: number }} */ (await res.json());
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 7200) * 1000,
  };
  return cachedToken.accessToken;
}

/** @type {number[] | null} */
let cachedAssigneeIds = null;

/**
 * Resolve the RFI assignee ids. Procore requires at least one. Prefers an
 * explicit `PROCORE_RFI_ASSIGNEE_ID` override; otherwise fetches the project's
 * users once and uses the first active one (cached for the process lifetime).
 * @param {string} token
 * @param {ReturnType<typeof procoreEnv>} e
 * @returns {Promise<number[]>}
 */
async function resolveAssigneeIds(token, e) {
  const override = process.env.PROCORE_RFI_ASSIGNEE_ID;
  if (override) return [Number(override)];
  if (cachedAssigneeIds) return cachedAssigneeIds;

  const res = await fetch(`${e.baseUrl}/rest/v1.0/projects/${e.projectId}/users?per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, 'Procore-Company-Id': String(e.companyId) },
  });
  if (!res.ok) {
    throw new Error(`Procore users fetch failed: ${res.status} ${await res.text()}`);
  }
  const users = /** @type {Array<{ id: number, is_active?: boolean }>} */ (await res.json());
  const assignee = users.find((u) => u.is_active) ?? users[0];
  if (!assignee) {
    throw new Error('Procore: no project users available to assign the RFI to');
  }
  cachedAssigneeIds = [assignee.id];
  return cachedAssigneeIds;
}

/**
 * Download the reported photo's bytes for attaching to the RFI. Only handles an
 * external URL (e.g. a Twilio media URL, fetched with Twilio Basic auth) — a
 * Slack-DM photo (photoSlackFileId, no photoUrl) needs the Slack client and is
 * left to the Slack card thread. Best-effort: null on absence or any failure.
 * @param {import('../../features/procore-issue-intake/issue-record.js').IssueRecord} record
 * @returns {Promise<{ bytes: ArrayBuffer, contentType: string, filename: string } | null>}
 */
async function downloadRfiPhoto(record) {
  if (!record.photoUrl) return null;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const headers =
    sid && token ? { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` } : undefined;
  try {
    const res = await fetch(record.photoUrl, headers ? { headers } : undefined);
    if (!res.ok) {
      console.error(`[procore] RFI photo download failed: ${res.status}`);
      return null;
    }
    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    const ext = (contentType.split('/')[1] ?? 'jpg').split(';')[0] || 'jpg';
    return { bytes: await res.arrayBuffer(), contentType, filename: `issue-photo.${ext}` };
  } catch (err) {
    console.error(`[procore] RFI photo download error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Upload a photo to Procore's file service ("prostore") and return its upload
 * uuid, to reference as an RFI attachment. This 3-step flow (create upload ->
 * POST bytes to the returned S3 presigned form -> reference the uuid) is used
 * instead of a plain multipart RFI attachment because it preserves the real
 * filename + content-type (via S3 Content-Disposition), so the attachment
 * downloads as a proper `issue-photo.jpg` rather than an extensionless blob.
 * (Procore's RFI viewer still won't preview images inline — a Procore-side
 * limitation — but the download is at least openable.) Best-effort: null on any
 * failure, so the RFI is never blocked on the photo.
 * @param {string} token
 * @param {ReturnType<typeof procoreEnv>} e
 * @param {{ bytes: ArrayBuffer, contentType: string, filename: string }} photo
 * @returns {Promise<string | null>}
 */
async function uploadPhotoToProcore(token, e, photo) {
  try {
    const createRes = await fetch(`${e.baseUrl}/rest/v1.0/companies/${e.companyId}/uploads`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Procore-Company-Id': String(e.companyId),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ response_filename: photo.filename, response_content_type: photo.contentType }),
    });
    if (!createRes.ok) {
      console.error(`[procore] upload create failed: ${createRes.status}`);
      return null;
    }
    const up = /** @type {{ uuid: string, url: string, fields: Record<string, string> }} */ (await createRes.json());

    // POST the bytes to the returned S3 presigned form (the file field must be last).
    const form = new FormData();
    for (const [k, v] of Object.entries(up.fields ?? {})) form.append(k, String(v));
    form.append('file', new Blob([photo.bytes], { type: photo.contentType }), photo.filename);
    const s3Res = await fetch(up.url, { method: 'POST', body: form });
    if (!s3Res.ok) {
      console.error(`[procore] S3 upload failed: ${s3Res.status}`);
      return null;
    }
    return up.uuid ?? null;
  } catch (err) {
    console.error(`[procore] photo upload error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Create an RFI in Procore from a structured issue record. When the record
 * carries a downloadable photo, it's uploaded to Procore's file service first
 * and referenced as an RFI attachment; the RFI itself is always a JSON create.
 * @param {import('../../features/procore-issue-intake/issue-record.js').IssueRecord} record
 * @returns {Promise<{ id: number, url: string | null }>}
 */
export async function createProcoreRfi(record) {
  if (!isProcoreConfigured()) {
    throw new Error(
      'Procore not configured — set PROCORE_BASE_URL / _CLIENT_ID / _CLIENT_SECRET / _COMPANY_ID / _PROJECT_ID.',
    );
  }
  const e = procoreEnv();
  const token = await getAccessToken();
  const assigneeIds = await resolveAssigneeIds(token, e);
  const payload = buildRfiPayload(record, assigneeIds);

  // Attach the photo (best-effort) by uploading it and referencing the uuid.
  const photo = await downloadRfiPhoto(record);
  if (photo) {
    const uuid = await uploadPhotoToProcore(token, e, photo);
    if (uuid) {
      /** @type {any} */ (payload.rfi).question.attachments = [{ upload_uuid: uuid }];
    }
  }

  const res = await fetch(`${e.baseUrl}/rest/v1.0/projects/${e.projectId}/rfis`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Procore-Company-Id': String(e.companyId),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Procore RFI create failed: ${res.status} ${await res.text()}`);
  }
  // Sandbox returns `link` (web URL) and `id`; older/other shapes may use html_url.
  const json = /** @type {{ id: number, link?: string, html_url?: string }} */ (await res.json());
  return { id: json.id, url: json.link ?? json.html_url ?? null };
}

/**
 * Post a reply on an RFI's question thread — used to record a resolution from the
 * Slack card. Pass `official: true` to mark it the official response (the closest
 * Procore lets us get to "resolved": the API can't flip an RFI's status to closed
 * with a service-account token — that needs the in-app close workflow — but an
 * official response is a clear, recorded resolution). Throws on failure; callers
 * treat it best-effort.
 * @param {number} rfiId
 * @param {string} body
 * @param {{ official?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export async function addRfiReply(rfiId, body, opts = {}) {
  if (!isProcoreConfigured()) return;
  const e = procoreEnv();
  const token = await getAccessToken();
  const res = await fetch(`${e.baseUrl}/rest/v1.0/projects/${e.projectId}/rfis/${rfiId}/replies`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Procore-Company-Id': String(e.companyId),
    },
    body: JSON.stringify({ reply: { body, official: Boolean(opts.official) } }),
  });
  if (!res.ok) {
    throw new Error(`Procore RFI reply failed: ${res.status} ${await res.text()}`);
  }
}
