import { newId } from './ids.js';
import type { QuestionInput, QuestionType, TestSettings } from './types.js';

export const defaultSettings: TestSettings = {
  randomizeQuestions: false,
  randomizeOptions: false,
  showScoreOnSubmit: true,
  allowLateSubmit: false,
  trackFocusEvents: true,
  requireStudentName: false,
  allowResume: true,
  passPercent: 60,
};

export function normalizeQuestion(input: QuestionInput, position: number): QuestionInput {
  const data: Record<string, any> = structuredClone(input.data ?? {});
  const type = input.type as QuestionType;
  if (type === 'single_choice' || type === 'multiple_choice') {
    const rawOptions = Array.isArray(data.options) ? data.options : [];
    const options = rawOptions.map((option: any) => typeof option === 'object' && option?.id
      ? { id: String(option.id), text: String(option.text ?? '') }
      : { id: newId(), text: String(option ?? '') });
    data.options = options;
    if (type === 'single_choice') {
      if (!data.correctOptionId && Number.isInteger(data.correctIndex) && options[data.correctIndex]) data.correctOptionId = options[data.correctIndex].id;
      data.correctOptionId = data.correctOptionId ? String(data.correctOptionId) : (options[0]?.id ?? '');
    } else {
      if (!Array.isArray(data.correctOptionIds) && Array.isArray(data.correctIndices)) data.correctOptionIds = data.correctIndices.map((index: number) => options[index]?.id).filter(Boolean);
      data.correctOptionIds = Array.isArray(data.correctOptionIds) ? data.correctOptionIds.map(String) : [];
    }
    delete data.correctIndex;
    delete data.correctIndices;
  }
  if (type === 'matching') {
    const pairs = Array.isArray(data.pairs) ? data.pairs : [];
    data.pairs = pairs.map((pair: any) => ({ id: String(pair.id ?? newId()), left: String(pair.left ?? ''), right: String(pair.right ?? '') }));
  }
  if (type === 'ordering') {
    const raw = Array.isArray(data.items) ? data.items : [];
    const items = raw.map((item: any) => typeof item === 'object' && item?.id ? { id: String(item.id), text: String(item.text ?? '') } : { id: newId(), text: String(item ?? '') });
    data.items = items;
    data.correctOrderIds = items.map((item: any) => item.id);
  }
  if (type === 'fill_blank') {
    data.accepted = Array.isArray(data.accepted) ? data.accepted.map(String).filter(Boolean) : [];
  }
  if (type === 'numeric') {
    data.correct = Number(data.correct ?? 0);
    data.tolerance = Math.max(0, Number(data.tolerance ?? 0));
  }
  if (type === 'short_text' || type === 'long_text' || type === 'code') {
    data.rubric = String(data.rubric ?? '');
  }
  return {
    id: input.id ?? newId(),
    position,
    type,
    prompt: String(input.prompt ?? '').trim(),
    points: Math.max(0, Number(input.points ?? 1)),
    data,
  };
}

export function normalizeTest(payload: any) {
  const raw = payload.settings ?? {};
  const settings: TestSettings = {
    randomizeQuestions: raw.randomizeQuestions === true,
    randomizeOptions: raw.randomizeOptions === true,
    showScoreOnSubmit: raw.showScoreOnSubmit !== false,
    allowLateSubmit: raw.allowLateSubmit === true,
    trackFocusEvents: raw.trackFocusEvents !== false,
    requireStudentName: raw.requireStudentName === true,
    allowResume: raw.allowResume !== false,
    passPercent: Math.min(100, Math.max(0, Number.isFinite(Number(raw.passPercent)) ? Number(raw.passPercent) : defaultSettings.passPercent)),
  };
  const questions = Array.isArray(payload.questions)
    ? payload.questions.map((question: QuestionInput, index: number) => normalizeQuestion(question, index))
    : [];
  return {
    title: String(payload.title ?? '').trim(),
    description: String(payload.description ?? '').trim(),
    durationSeconds: Math.max(0, Math.min(86400, Number(payload.durationSeconds ?? 600))),
    settings,
    questions,
  };
}
