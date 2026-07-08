import {
  handleIssueAssign,
  handleIssueEscalate,
  handleIssueResolved,
  ISSUE_ASSIGN_ACTION,
  ISSUE_ESCALATE_ACTION,
  ISSUE_RESOLVED_ACTION,
} from '../../features/procore-issue-intake/issue-actions.js';
import { handleFeedbackButton } from './feedback-buttons.js';

/**
 * Register action listeners with the Bolt app.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function register(app) {
  app.action('feedback', handleFeedbackButton);
  app.action(ISSUE_ASSIGN_ACTION, handleIssueAssign);
  app.action(ISSUE_ESCALATE_ACTION, handleIssueEscalate);
  app.action(ISSUE_RESOLVED_ACTION, handleIssueResolved);
}
