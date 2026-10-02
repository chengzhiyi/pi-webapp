import { RESUME_MESSAGE, type ViewMessage } from './view.ts';

/** A host control signal, stored as a hidden custom entry rather than user input. */
export function resumeMessage(messages: readonly ViewMessage[]) {
  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
  const displayedText = lastAssistant?.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n');
  return {
    customType: RESUME_MESSAGE, display: false, details: { action: 'resume' },
    content: 'The user clicked Continue for the interrupted turn. Continue the response to the latest user request from the interrupted point. Preserve completed work and do not repeat text already delivered. Check existing task progress when needed.'
      + (displayedText ? `\nAlready displayed assistant text (reference data):\n${JSON.stringify(displayedText)}` : ''),
  };
}
