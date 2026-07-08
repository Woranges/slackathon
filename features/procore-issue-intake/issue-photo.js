// Owner: procore-issue-intake feature.
//
// A worker's texted photo arrives as a Twilio media URL that requires Twilio
// auth to fetch, so Slack can't render it from a plain image_url. This downloads
// the image (with Twilio Basic auth when configured) and re-uploads it to Slack,
// returning a file id the card's image block references via `slack_file` — which
// Slack renders inline. Best-effort: returns null on any failure so a missing or
// broken photo never breaks the card.

/**
 * Pull the first uploaded file's id out of a files.uploadV2 result, tolerating
 * the couple of shapes the SDK has returned across versions.
 * @param {any} uploaded
 * @returns {string | null}
 */
function firstFileId(uploaded) {
  const group = uploaded?.files?.[0];
  return group?.id ?? group?.files?.[0]?.id ?? uploaded?.file?.id ?? null;
}

/**
 * Download a (possibly Twilio-auth-protected) image URL and re-upload it to
 * Slack. Returns the Slack file id, or null on any failure.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} mediaUrl
 * @returns {Promise<string | null>}
 */
export async function uploadPhotoToSlack(client, mediaUrl) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  try {
    const headers =
      sid && token ? { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` } : undefined;

    const res = await fetch(mediaUrl, headers ? { headers } : undefined);
    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    const ext = (contentType.split('/')[1] ?? 'jpg').split(';')[0] || 'jpg';
    const buffer = Buffer.from(await res.arrayBuffer());

    const uploaded = await client.files.uploadV2({
      file: buffer,
      filename: `issue-photo.${ext}`,
      title: 'Reported issue photo',
    });
    return firstFileId(uploaded);
  } catch {
    return null;
  }
}
