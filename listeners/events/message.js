import { runAgent } from '../../agent/index.js';
import { postIssueCard } from '../../features/procore-issue-intake/issue-card.js';
import {
  advanceIssueIntake,
  hasActiveFlow,
  isIssueIntakeTrigger,
} from '../../features/procore-issue-intake/issue-intake.js';
import { conversationStore } from '../../thread-context/index.js';
import { buildFeedbackBlocks } from '../views/feedback-builder.js';

/**
 * @param {import('@slack/types').MessageEvent} event
 * @returns {event is import('@slack/types').GenericMessageEvent}
 */
function isGenericMessageEvent(event) {
  return !('subtype' in event && event.subtype !== undefined);
}

/**
 * Handle messages sent to the agent via DM or in threads the bot is part of.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'message'>} args
 * @returns {Promise<void>}
 */
export async function handleMessage({ client, context, event, logger, say, sayStream, setStatus }) {
  // Skip message subtypes (edits, deletes, etc.)
  if (!isGenericMessageEvent(event)) return;

  // Skip bot messages
  if (event.bot_id) return;

  const isDm = event.channel_type === 'im';
  const isThreadReply = !!event.thread_ts;

  if (isDm) {
    // DMs are always handled
  } else if (isThreadReply) {
    // Channel thread replies are handled only if the bot is already engaged
    if (!conversationStore.hasHistory(event.channel, /** @type {string} */ (event.thread_ts))) return;
  } else {
    // Top-level channel messages are handled by app_mentioned
    return;
  }

  try {
    const channelId = event.channel;
    const text = event.text || '';
    const threadTs = event.thread_ts || event.ts;
    const userId = /** @type {string} */ (context.userId);

    // Issue-intake flow (its own LLM conversation, separate from the general
    // agent below) — check for it before falling through.
    if (isIssueIntakeTrigger(text) || hasActiveFlow(channelId, threadTs)) {
      // Capture a photo attached in the DM (already Slack-hosted → use its file id).
      const imageFile = event.files?.find((f) => f.mimetype?.startsWith('image/'));
      const photoSlackFileId = imageFile?.id ?? null;
      // If only a photo was sent (no text), nudge the model so it knows.
      const intakeText = text || (photoSlackFileId ? '[photo attached]' : text);

      const { reply, done, record } = await advanceIssueIntake(channelId, threadTs, intakeText, {
        slackUserId: userId,
        photoSlackFileId,
      });
      await say({ text: reply, thread_ts: threadTs });
      // Once the issue is filed, post the card to the management channel.
      if (done && record) {
        const result = await postIssueCard(client, record);
        if (!result.posted) logger.info(`Issue filed but card not posted: ${result.reason}`);
      }
      return;
    }

    // Get prior conversation history for this thread
    const existingHistory = conversationStore.getHistory(channelId, threadTs);

    // Set assistant thread status with loading messages
    await setStatus({
      status: 'Thinking…',
      loading_messages: [
        'Teaching the hamsters to type faster…',
        'Untangling the internet cables…',
        'Consulting the office goldfish…',
        'Polishing up the response just for you…',
        'Convincing the AI to stop overthinking…',
      ],
    });

    // Run the agent with deps for tool access
    const deps = { client, userId, channelId, threadTs, messageTs: event.ts, userToken: context.userToken };
    const { responseText, history: newHistory } = await runAgent(text, existingHistory, deps);

    // Stream response in thread with feedback buttons
    const streamer = sayStream();
    await streamer.append({ markdown_text: responseText });
    const feedbackBlocks = buildFeedbackBlocks();
    await streamer.stop({ blocks: feedbackBlocks });

    // Store updated history for future context
    conversationStore.setHistory(channelId, threadTs, newHistory);
  } catch (e) {
    logger.error(`Failed to handle message: ${e}`);
    await say({
      text: `:warning: Something went wrong! (${e})`,
      thread_ts: event.thread_ts || event.ts,
    });
  }
}
