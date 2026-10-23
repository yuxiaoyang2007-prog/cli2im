import { randomBytes } from 'node:crypto';
import type { AgentQuestion, CardButton, CardPayload, SessionKey } from '../types.js';

/** One AskUserQuestion call waiting for the chat user, answered by buttons or a text reply. */
export interface PendingQuestion {
  requestId: string;
  /** Short id carried in button callbacks (Telegram callback_data is limited to 64 bytes). */
  token: string;
  questions: AgentQuestion[];
  /** Keyed by question text, as the AskUserQuestion tool expects. */
  answers: Record<string, string>;
  selections: Map<number, Set<number>>;
  messageId?: string;
}

export class QuestionBoard {
  private pending = new Map<SessionKey, PendingQuestion>();

  open(key: SessionKey, requestId: string, questions: AgentQuestion[]): PendingQuestion {
    const entry: PendingQuestion = {
      requestId, token: randomBytes(4).toString('hex'), questions, answers: {}, selections: new Map(),
    };
    this.pending.set(key, entry);
    return entry;
  }

  get(key: SessionKey): PendingQuestion | undefined {
    return this.pending.get(key);
  }

  close(key: SessionKey, requestId: string): boolean {
    if (this.pending.get(key)?.requestId !== requestId) return false;
    this.pending.delete(key);
    return true;
  }

  /** Applies a button press; returns whether every question now has an answer. */
  select(entry: PendingQuestion, questionIndex: number, optionIndex: number): boolean {
    const question = entry.questions[questionIndex];
    if (!question || question.question in entry.answers) return isComplete(entry);
    if (!question.multiSelect) {
      const option = question.options[optionIndex];
      if (option) entry.answers[question.question] = option.label;
      return isComplete(entry);
    }
    const picked = entry.selections.get(questionIndex) ?? new Set<number>();
    if (optionIndex === question.options.length) {
      // The trailing "done" button submits the toggled options.
      if (picked.size > 0) {
        entry.answers[question.question] = [...picked].sort((a, b) => a - b)
          .map((index) => question.options[index].label).join(', ');
      }
    } else if (question.options[optionIndex]) {
      if (picked.has(optionIndex)) picked.delete(optionIndex);
      else picked.add(optionIndex);
      entry.selections.set(questionIndex, picked);
    }
    return isComplete(entry);
  }
}

function isComplete(entry: PendingQuestion): boolean {
  return entry.questions.every((question) => question.question in entry.answers);
}

/** A text reply answers every open question: one line each when the counts match, else the whole text. */
export function answersFromText(entry: PendingQuestion, text: string): Record<string, string> {
  const open = entry.questions.filter((question) => !(question.question in entry.answers));
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const replies = open.length > 1 && lines.length === open.length ? lines : open.map(() => text.trim());
  const answers = { ...entry.answers };
  open.forEach((question, index) => { answers[question.question] = resolveReply(question, replies[index]); });
  return answers;
}

// "2" or "1,3" picks options by number; anything else is a free-text answer.
function resolveReply(question: AgentQuestion, reply: string): string {
  if (/^\d+([\s,，、]+\d+)*$/.test(reply)) {
    const picks = [...new Set(reply.split(/[\s,，、]+/).map(Number))]
      .filter((number) => number >= 1 && number <= question.options.length);
    if (picks.length > 0 && (question.multiSelect || picks.length === 1)) {
      return picks.map((number) => question.options[number - 1].label).join(', ');
    }
  }
  return reply;
}

export function buildQuestionCard(entry: PendingQuestion, state: 'open' | 'done' | 'expired' = 'open'): CardPayload {
  const multiple = entry.questions.length > 1;
  const lines: string[] = [
    state === 'open'
      ? '点按钮选择，或直接回复文字作答（回复数字选对应选项，多个问题可按行依次回答）。'
      : state === 'done' ? '已提交回答。' : '这个问题已失效。',
  ];
  const buttons: CardButton[] = [];
  entry.questions.forEach((question, questionIndex) => {
    const prefix = multiple ? `${questionIndex + 1}. ` : '';
    lines.push('', `**${prefix}${question.header ? `${question.header}：` : ''}${question.question}**`
      + (question.multiSelect ? '（可多选）' : ''));
    question.options.forEach((option, optionIndex) => {
      lines.push(`${optionIndex + 1}) ${option.label}${option.description ? ` — ${option.description}` : ''}`);
    });
    const answer = entry.answers[question.question];
    if (answer !== undefined) {
      lines.push(`✅ ${answer}`);
      return;
    }
    if (state !== 'open') return;
    const picked = entry.selections.get(questionIndex);
    const label = multiple ? `${questionIndex + 1}·` : '';
    question.options.forEach((option, optionIndex) => {
      buttons.push({
        text: `${label}${question.multiSelect ? (picked?.has(optionIndex) ? '☑ ' : '☐ ') : ''}${option.label}`,
        value: `ask:${entry.token}:${questionIndex}:${optionIndex}`,
        type: 'default',
      });
    });
    if (question.multiSelect) {
      buttons.push({ text: `${label}完成选择`, value: `ask:${entry.token}:${questionIndex}:${question.options.length}`, type: 'primary' });
    }
  });
  return {
    type: 'question',
    title: state === 'open' ? 'Claude 需要你选择' : 'Claude 的提问',
    content: lines.join('\n'),
    ...(buttons.length > 0 ? { buttons } : {}),
  };
}
