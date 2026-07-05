// Owner: safety-broadcast feature.
//
// Inbound Twilio webhook — worker SMS replies land here (issue reports,
// broadcast acknowledgments). Only reachable when running in HTTP mode
// (app-oauth.js), since Socket Mode (app.js) exposes no inbound HTTP endpoint.

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
export async function handleTwilioInboundSms(req, res) {
  const _from = req.body?.From;
  const _body = req.body?.Body;

  // TODO: look up the worker by `from` (lib/db.js#getWorkerByPhone).
  // TODO: if this reply is an acknowledgment to an open broadcast, record it
  // (lib/db.js#recordBroadcastAck) and update the live Slack message.
  // TODO: otherwise, treat it as the start (or continuation) of a structured
  // issue-intake flow and eventually call
  // features/procore-issue-intake/issue-intake.js's logic, posting the
  // result into the right Slack channel.

  res.status(200).type('text/xml').send('<Response></Response>');
}
