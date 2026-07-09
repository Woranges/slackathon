// Owner: procore-issue-intake feature.
//
// Gets a worker's reported photo into the management channel so it's visible with
// the issue. We deliberately do NOT use an inline image block: Slack rejects a
// `slack_file` reference to a freshly-uploaded bot file ("invalid slack file")
// because it isn't shared into the conversation, and `image_url` can't fetch the
// auth-protected DM/Twilio source URLs. Instead we upload the image bytes into
// the card's thread via files.uploadV2(channel_id, thread_ts): that shares the
// file properly so it renders, and keeps the channel timeline to a single
// top-level card with the photo one click away in its thread.
//
// Two photo sources:
//   - DM: the worker uploaded it into their DM with the bot (a Slack file id);
//     download it with the bot token (files:read), then re-upload to the channel.
//   - Texted (SMS/MMS): a Twilio media URL (Twilio-auth-protected); download it
//     with Twilio Basic auth, then upload.
// Best-effort: any failure logs and returns false so a missing/broken photo never
// breaks the card.

/**
 * @typedef {import('./issue-record.js').IssueRecord} IssueRecord
 */

/** @param {string} contentType */
function extFromContentType(contentType) {
  return (contentType.split('/')[1] ?? 'jpg').split(';')[0] || 'jpg';
}

/**
 * Download a worker's DM-uploaded file (owned by them, private to the DM) with
 * the bot token. Returns the raw bytes, or null on any failure.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} fileId
 * @returns {Promise<{ buffer: Buffer, ext: string } | null>}
 */
async function loadSlackDmFile(client, fileId) {
  const info = /** @type {any} */ (await client.files.info({ file: fileId }));
  const url = info?.file?.url_private_download ?? info?.file?.url_private;
  if (!url) {
    console.error(`[issue-photo] files.info returned no download url for ${fileId}`);
    return null;
  }
  // Slack private file URLs require the bot token as a bearer to download.
  const token = /** @type {any} */ (client).token ?? process.env.SLACK_BOT_TOKEN;
  const res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
  if (!res.ok) {
    console.error(`[issue-photo] download failed (${res.status}) for ${fileId}`);
    return null;
  }
  const contentType = res.headers.get('content-type') ?? info?.file?.mimetype ?? 'image/jpeg';
  // A private URL fetched without a valid token returns Slack's HTML login page
  // (200 OK, text/html) instead of the image — catch that so we don't re-upload it.
  if (contentType.includes('text/html')) {
    console.error(`[issue-photo] got HTML (bad/missing token?) instead of an image for ${fileId}`);
    return null;
  }
  return { buffer: Buffer.from(await res.arrayBuffer()), ext: extFromContentType(contentType) };
}

/**
 * Download a (possibly Twilio-auth-protected) external media URL. Returns the raw
 * bytes, or null on any failure.
 * @param {string} mediaUrl
 * @returns {Promise<{ buffer: Buffer, ext: string } | null>}
 */
async function loadExternalUrl(mediaUrl) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const headers =
    sid && token ? { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` } : undefined;
  const res = await fetch(mediaUrl, headers ? { headers } : undefined);
  if (!res.ok) {
    console.error(`[issue-photo] media download failed (${res.status})`);
    return null;
  }
  const contentType = res.headers.get('content-type') ?? 'image/jpeg';
  return { buffer: Buffer.from(await res.arrayBuffer()), ext: extFromContentType(contentType) };
}

/**
 * Download the reported photo's bytes from whichever source the record carries
 * (DM file id or external URL), or null when there's no photo.
 * @param {import('@slack/web-api').WebClient} client
 * @param {IssueRecord} record
 * @returns {Promise<{ buffer: Buffer, ext: string } | null>}
 */
function loadPhotoBytes(client, record) {
  if (record.photoSlackFileId) return loadSlackDmFile(client, record.photoSlackFileId);
  if (record.photoUrl) return loadExternalUrl(record.photoUrl);
  return Promise.resolve(null);
}

/**
 * Post the reported photo as a reply in the card's thread. Uploading with
 * channel_id + thread_ts shares the file properly (so it renders) and keeps the
 * channel to a single top-level card. Best-effort; returns false on any failure.
 * @param {import('@slack/web-api').WebClient} client
 * @param {IssueRecord} record
 * @param {string} channel
 * @param {string} threadTs
 * @returns {Promise<boolean>}
 */
export async function postPhotoReply(client, record, channel, threadTs) {
  try {
    const src = await loadPhotoBytes(client, record);
    if (!src) return false;
    await client.files.uploadV2({
      file: src.buffer,
      filename: `issue-photo.${src.ext}`,
      title: 'Reported issue photo',
      channel_id: channel,
      thread_ts: threadTs,
    });
    console.log(`[issue-photo] posted photo reply (${src.buffer.length} bytes) to ${channel} thread ${threadTs}`);
    return true;
  } catch (err) {
    const data = /** @type {any} */ (err)?.data;
    const scopeInfo = data?.needed ? ` (needed=${data.needed}, provided=${data.provided})` : '';
    console.error(
      `[issue-photo] postPhotoReply failed: ${err instanceof Error ? err.message : String(err)}${scopeInfo}`,
    );
    return false;
  }
}
